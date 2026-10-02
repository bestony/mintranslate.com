/**
 * Translation result processing.
 *
 * Everything here operates on the model's plain text output. Segmentation lives
 * at the presentation layer rather than in the request, for two reasons: it keeps
 * the request free of an extra instruction that would change model behaviour, and
 * it works whether the model returns structured paragraphs or one blob (the PRD's
 * risk table notes that output format is not reliably controllable).
 *
 * Copying rebuilds from the same segments the view renders, so the clipboard
 * cannot drift from what the user sees.
 */

/** One rendered translation segment. */
export interface Segment {
	/** Stable index, used as a render key and for hover pairing. */
	readonly index: number;
	readonly text: string;
}

/**
 * Split translated text into segments.
 *
 * Boundaries: a blank line, or a sentence-ending punctuation mark followed by
 * whitespace. Punctuation families are covered for Latin, CJK and Arabic text so
 * a segment split does not depend on the source language.
 */
const SENTENCE_END = /([.。！!？?；;…])(?=\s|$)/;
const PARAGRAPH_BREAK = /\n\s*\n/;

export function segmentTranslation(text: string): readonly Segment[] {
	const trimmed = text.trim();
	if (trimmed === "") return [];

	const segments: string[] = [];

	for (const paragraph of trimmed.split(PARAGRAPH_BREAK)) {
		const block = paragraph.trim();
		if (block === "") continue;

		// A single line may hold several sentences; keep each as its own segment
		// so the hover pairing points at something readable.
		let current = "";
		for (const line of block.split("\n")) {
			const piece = line.trim();
			if (piece === "") continue;

			for (const part of splitSentences(piece)) {
				current = current === "" ? part : `${current} ${part}`;
				if (SENTENCE_END.test(part)) {
					segments.push(current.trim());
					current = "";
				}
			}
		}

		if (current.trim() !== "") segments.push(current.trim());
	}

	return segments.map((entry, index) => ({ index, text: entry }));
}

/** Split one line at sentence boundaries, keeping the punctuation attached. */
function splitSentences(line: string): string[] {
	const parts: string[] = [];
	let buffer = "";

	for (const char of line) {
		buffer += char;
		// Consume trailing spaces into the finished sentence instead of starting
		// the next one with them.
		if (SENTENCE_END.test(buffer)) {
			parts.push(buffer.trim());
			buffer = "";
		}
	}

	if (buffer.trim() !== "") parts.push(buffer.trim());
	return parts;
}

/**
 * Build the clipboard payload from segments.
 *
 * Plain text only: no Markdown markers, no whitespace beyond the blank line
 * between segments. Rebuilding from segments (rather than passing the raw model
 * output through) is what guarantees this.
 */
export function toPlainText(segments: readonly Segment[]): string {
	return (
		segments
			.map((segment) => stripMarkdown(segment.text))
			.filter((text) => text !== "")
			// Blank line between segments: enough to keep them visually separate
			// without adding anything the segments did not contain.
			.join("\n\n")
	);
}

/**
 * Remove Markdown markers.
 *
 * Deliberately conservative: only markers that would be visible noise in plain
 * text are removed, and no attempt is made to interpret the document. A model may
 * emit Markdown-like text as content, and over-eager stripping would corrupt it.
 */
export function stripMarkdown(text: string): string {
	return (
		text
			// Fenced code blocks: keep the code, drop the fences.
			.replace(/```[a-zA-Z0-9]*\n?/g, "")
			.replace(/~~~[a-zA-Z0-9]*\n?/g, "")
			// Inline code backticks.
			.replace(/`([^`]*)`/g, "$1")
			// Headings.
			.replace(/^\s{0,3}#{1,6}\s+/gm, "")
			// Block quotes.
			.replace(/^\s{0,3}>\s?/gm, "")
			// Bullet and numbered list markers at line start.
			.replace(/^\s{0,3}[-*+]\s+/gm, "")
			.replace(/^\s{0,3}\d+[.)]\s+/gm, "")
			// Emphasis markers. Underscores are only treated as emphasis when they
			// wrap a whole word: in a translation an underscore is far more likely to
			// be part of an identifier (`my_function_name`) than a marker, and eating
			// it would corrupt code the user is about to paste.
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
			.replace(/(^|[\s(])_([^_\s][^_]*[^_\s])_($|[\s).,])/g, "$1$2$3")
			// Collapse the whitespace the removals may have left behind.
			.replace(/[ \t]+/g, " ")
			.replace(/ ?\n ?/g, "\n")
			.trim()
	);
}

/** Character count by Unicode code points, as the PRD requires. */
export function countCharacters(text: string): number {
	// `Array.from` iterates by code point, so an astral character (emoji) counts
	// as one, unlike `.length` which would count its surrogate pair as two.
	return Array.from(text).length;
}

/** Input limit for a single translation. */
export const MAX_INPUT_CHARACTERS = 5000;

/** Fraction of the limit at which the counter turns into a warning. */
export const WARNING_THRESHOLD = 0.9;

/** State of the character counter. */
export type CounterState = "normal" | "warning" | "at-limit";

/** Describe the counter for a given length. */
export function counterState(length: number): CounterState {
	if (length >= MAX_INPUT_CHARACTERS) return "at-limit";
	if (length / MAX_INPUT_CHARACTERS >= WARNING_THRESHOLD) return "warning";
	return "normal";
}

/** Result of accepting input, possibly truncated. */
export interface AcceptedInput {
	readonly text: string;
	/** Set when the input had to be truncated, so the user can be told. */
	readonly truncatedFrom?: number;
}

/**
 * Accept pasted or typed input, truncating at the limit.
 *
 * Truncation is reported rather than silent: dropping the user's text without
 * saying so is the failure mode the spec calls out.
 */
export function acceptInput(text: string): AcceptedInput {
	const length = countCharacters(text);
	if (length <= MAX_INPUT_CHARACTERS) return { text };

	// Slice by code point so a truncation cannot split a surrogate pair.
	const truncated = Array.from(text).slice(0, MAX_INPUT_CHARACTERS).join("");
	return { text: truncated, truncatedFrom: length };
}

/** Truncation notice for the user. */
export function truncationNotice(from: number): string {
	return `内容超过 ${MAX_INPUT_CHARACTERS} 字符上限，已截断（原为 ${from} 字符）。`;
}

/** The counter label shown under the input. */
export function counterLabel(length: number): string {
	return `目前为 ${length} 个字符（上限为 ${MAX_INPUT_CHARACTERS.toLocaleString("en-US")} 个字符）`;
}

/** Copy outcome, so the view can show a降级 hint instead of failing silently. */
export type CopyOutcome =
	| { readonly kind: "copied" }
	| { readonly kind: "unsupported"; readonly message: string };

/** How long the "copied" confirmation stays visible. */
export const COPY_FEEDBACK_MS = 2000;

/**
 * Copy text to the clipboard.
 *
 * When the clipboard API is unavailable the caller gets an explicit outcome, so
 * the UI can point the user at manual copying instead of appearing to do nothing.
 */
export async function copyPlainText(
	text: string,
	clipboard:
		| { writeText(value: string): Promise<void> }
		| undefined = typeof navigator === "undefined"
		? undefined
		: navigator.clipboard,
): Promise<CopyOutcome> {
	if (!clipboard || typeof clipboard.writeText !== "function") {
		return {
			kind: "unsupported",
			message: "当前浏览器不支持自动复制，请手动选择译文后复制。",
		};
	}

	try {
		await clipboard.writeText(text);
		return { kind: "copied" };
	} catch {
		// Permission denial surfaces here (for example outside a user gesture).
		return {
			kind: "unsupported",
			message: "复制未获授权，请手动选择译文后复制。",
		};
	}
}
