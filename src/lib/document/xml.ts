/**
 * Minimal XML text-node reading and writing.
 *
 * Why not `DOMParser`: **it does not exist in a Web Worker.** Workers have no
 * browsing context and no DOM, so the requirement that parsing happen off the main
 * thread rules it out. The alternatives were to run this on the main thread (which
 * the requirement forbids) or to bundle a full XML parser for the one thing needed
 * here — reading and replacing the contents of known text elements. Scanning the
 * string is the smaller correct answer.
 *
 * The whole correctness risk of this module is **escaping**. A translated sentence
 * can contain `&`, `<` or `>`, and writing it raw would produce a document that no
 * longer parses. So:
 *
 * - reading decodes entities and unwraps CDATA;
 * - writing encodes `&`, `<` and `>` (the three that must be escaped in character
 *   data) and never emits CDATA.
 *
 * Text inside CDATA is read as-is and written back escaped, which is safe: CDATA is
 * a way to *write* literal text, not a promise about how it is written.
 */

/** A text element found in a part, with the span of its content. */
export interface TextSpan {
	/** Byte offsets of the content between the open and close tags. */
	readonly start: number;
	readonly end: number;
	/** Decoded content. */
	readonly text: string;
	/** Whether the element was self-closing (no content to replace). */
	readonly selfClosing: boolean;
}

/** Characters that must be escaped in character data. */
export function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Named entities worth decoding; the rest are left as written. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/**
 * Decode entity references in text.
 *
 * Unknown named entities are left untouched rather than dropped: a document using a
 * DTD-defined entity should round-trip unchanged, not lose the reference.
 */
export function decodeXmlText(value: string): string {
	return value.replace(
		/&(#x?[0-9a-fA-F]+|[a-zA-Z][\w.-]*);/g,
		(match, body: string) => {
			if (body.startsWith("#")) {
				const hex = body[1] === "x" || body[1] === "X";
				const code = Number.parseInt(
					hex ? body.slice(2) : body.slice(1),
					hex ? 16 : 10,
				);
				if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
				try {
					return String.fromCodePoint(code);
				} catch {
					return match;
				}
			}
			return NAMED_ENTITIES[body] ?? match;
		},
	);
}

/** Body content of a CDATA section, unwrapped. */
function unwrapCdata(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith("<![CDATA[") || !trimmed.endsWith("]]>"))
		return value;
	return trimmed.slice("<![CDATA[".length, -"]]>".length);
}

/**
 * Find every instance of a text element in a part.
 *
 * Matches both `<name>content</name>` and the self-closing `<name/>`. Namespace
 * prefixes are matched literally, which is what the four formats need: the elements
 * of interest are always `w:t`, `a:t` or `t` with a known prefix.
 */
export function findTextSpans(xml: string, elementName: string): TextSpan[] {
	const spans: TextSpan[] = [];
	const escaped = elementName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	// Content between an open tag (with optional attributes) and its close tag.
	const paired = new RegExp(
		`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}\\s*>`,
		"g",
	);
	for (const match of xml.matchAll(paired)) {
		const raw = match[1];
		const contentStart = (match.index ?? 0) + match[0].indexOf(raw);
		spans.push({
			start: contentStart,
			end: contentStart + raw.length,
			text: decodeXmlText(unwrapCdata(raw)),
			selfClosing: false,
		});
	}

	// Self-closing elements carry no content, so they can be read but not replaced.
	const selfClosing = new RegExp(`<${escaped}(?:\\s[^>]*)?/>`, "g");
	for (const match of xml.matchAll(selfClosing)) {
		const at = match.index ?? 0;
		spans.push({
			start: at,
			end: at + match[0].length,
			text: "",
			selfClosing: true,
		});
	}

	return spans.sort((left, right) => left.start - right.start);
}

/**
 * Replace the contents of the text elements at the given spans.
 *
 * Replacements are applied back to front so that earlier offsets stay valid — doing
 * it forwards would shift every later span by the length difference of each edit.
 */
export function replaceTextSpans(
	xml: string,
	replacements: readonly { readonly span: TextSpan; readonly value: string }[],
): string {
	const ordered = [...replacements]
		.filter((entry) => !entry.span.selfClosing)
		.sort((left, right) => right.span.start - left.span.start);

	let result = xml;
	for (const { span, value } of ordered) {
		result =
			result.slice(0, span.start) +
			escapeXmlText(value) +
			result.slice(span.end);
	}
	return result;
}

/**
 * Collect the text of a run of sibling elements, joined as they read.
 *
 * OOXML splits a sentence across runs, so a paragraph's text is the concatenation
 * of its text elements — and the *runs between them are what carries formatting*.
 * Reading them together is what allows translating a whole sentence instead of
 * fragments.
 */
export function joinSpans(spans: readonly TextSpan[]): string {
	return spans.map((span) => span.text).join("");
}

/**
 * Distribute a translated value across the spans a paragraph was read from.
 *
 * The translation goes into the first span and the rest are emptied. The
 * alternative — trying to split the translation back across runs in proportion —
 * would break words apart, which is exactly what must not happen. Keeping the first
 * run's formatting for the whole paragraph is the accepted trade-off for preserving
 * run-level attributes rather than the original per-run text split.
 */
export function distributeAcrossSpans(
	spans: readonly TextSpan[],
	value: string,
): { readonly span: TextSpan; readonly value: string }[] {
	const replaceable = spans.filter((span) => !span.selfClosing);
	if (replaceable.length === 0) return [];

	return replaceable.map((span, index) => ({
		span,
		value: index === 0 ? value : "",
	}));
}

/**
 * Whether a rebuilt part is structurally sound.
 *
 * This is the guard against the module's main failure mode: a translation written
 * without escaping produces a file no host application can open, and the user would
 * only discover it after downloading. So the check covers three things that a bad
 * write would break:
 *
 * 1. **Tags balance** — an unclosed tag means a replacement ate markup.
 * 2. **No stray `<` in character data** — a raw `<` that is not a tag, comment,
 *    declaration or CDATA section is invalid, and is what unescaped output looks
 *    like.
 * 3. **Every `&` starts a valid entity** — a bare `&` is likewise invalid.
 *
 * It is deliberately not a validating parser: the four formats' parts are
 * machine-generated, so structure is the only thing likely to be wrong.
 */
export function isWellFormed(xml: string): boolean {
	// Comments, declarations and CDATA may legally contain characters that are
	// invalid in character data, so they are removed before the gap check.
	const withoutOpaque = xml
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
		.replace(/<\?[\s\S]*?\?>/g, "")
		.replace(/<![^>]*>/g, "");

	const stack: string[] = [];
	const tagPattern =
		/<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

	let lastEnd = 0;
	for (const match of withoutOpaque.matchAll(tagPattern)) {
		const at = match.index ?? 0;

		// The gap between two tags is character data: a `<` there is invalid.
		if (withoutOpaque.slice(lastEnd, at).includes("<")) return false;
		lastEnd = at + match[0].length;

		const [, closing, name, , selfClose] = match;
		if (closing === "/") {
			// A close tag must match the innermost open tag.
			if (stack.pop() !== name) return false;
			continue;
		}
		if (selfClose === "/") continue;
		stack.push(name);
	}

	if (withoutOpaque.slice(lastEnd).includes("<")) return false;
	if (stack.length > 0) return false;

	// Every ampersand must open a valid entity reference.
	return !/&(?!#\d+;|#x[0-9a-fA-F]+;|[A-Za-z][\w.-]*;)/.test(withoutOpaque);
}
