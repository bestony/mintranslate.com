/**
 * OOXML extraction and rebuild.
 *
 * The three formats are built on the same package structure but store text in
 * different parts and elements. Each is described declaratively below so the
 * coverage is auditable: it is easy to handle only `word/document.xml` and look
 * correct on a simple test document while silently skipping every header, footnote
 * and comment.
 *
 * Two rules shape the text handling:
 *
 * 1. **A paragraph is the unit of translation.** OOXML splits sentences across runs
 *    (`w:r`), so translating per run would cut words apart. A paragraph's text is
 *    read as the concatenation of its text elements and written back to the first
 *    one, with the others emptied — the standard way to change a paragraph's text
 *    without disturbing its run properties.
 * 2. **Untouched entries stay byte-identical.** Only parts whose text actually
 *    changed are re-encoded; everything else is written back from the original
 *    bytes, which is what keeps images, styles and relationships intact.
 */

import type { DocumentFormat, ParsedDocument, TextChunk } from "./model";
import {
	findTextSpans,
	isWellFormed,
	joinSpans,
	replaceTextSpans,
} from "./xml";
import {
	entryPathsMatching,
	type PackageEntries,
	readPackage,
	readTextEntry,
	writePackage,
	writeTextEntry,
} from "./zip";

/** Text element and part patterns for one format. */
interface FormatSpec {
	/** Element holding text, e.g. `w:t`. */
	readonly textElement: string;
	/** Element delimiting a paragraph, e.g. `w:p`. */
	readonly paragraphElement: string;
	/** Paths (or patterns) of the parts that hold translatable text. */
	readonly partPatterns: readonly RegExp[];
}

const SPECS: Record<DocumentFormat, FormatSpec | undefined> = {
	// Body text, tables, headers/footers, footnotes/endnotes and comments all live in
	// separate parts. Tables are inside `document.xml`, so they need no extra part.
	docx: {
		textElement: "w:t",
		paragraphElement: "w:p",
		partPatterns: [
			/^word\/document\.xml$/,
			/^word\/header\d*\.xml$/,
			/^word\/footer\d*\.xml$/,
			/^word\/footnotes\.xml$/,
			/^word\/endnotes\.xml$/,
			/^word\/comments\.xml$/,
		],
	},
	pptx: {
		textElement: "a:t",
		paragraphElement: "a:p",
		partPatterns: [
			/^ppt\/slides\/slide\d+\.xml$/,
			/^ppt\/notesSlides\/notesSlide\d+\.xml$/,
		],
	},
	xlsx: {
		textElement: "t",
		paragraphElement: "si",
		partPatterns: [/^xl\/sharedStrings\.xml$/],
	},
	// PDFs have no XML parts; text comes from the PDF parser instead.
	pdf: undefined,
};

/** Whether this format is parsed from a zip package. */
export function isOoxmlFormat(format: DocumentFormat): boolean {
	return SPECS[format] !== undefined;
}

/** One paragraph located in a part. */
interface Paragraph {
	readonly part: string;
	readonly index: number;
	/** Text element spans belonging to this paragraph. */
	readonly spans: ReturnType<typeof findTextSpans>;
}

/**
 * Locate every paragraph in a part.
 *
 * Works on the paragraph element rather than on the whole part, so runs belonging
 * to different paragraphs are never joined into one another.
 */
function paragraphsIn(
	part: string,
	xml: string,
	spec: FormatSpec,
): Paragraph[] {
	const escaped = spec.paragraphElement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const paragraphTags = new RegExp(`<(/?)${escaped}(?:\\s[^>]*)?(/?)>`, "g");
	const allSpans = findTextSpans(xml, spec.textElement);
	const frames: {
		readonly order: number;
		readonly bodyStart: number;
		readonly spans: ReturnType<typeof findTextSpans>;
	}[] = [];
	const open: (typeof frames)[number][] = [];
	let nextSpan = 0;

	const assignSpansBefore = (end: number): void => {
		while (nextSpan < allSpans.length) {
			const span = allSpans[nextSpan];
			if (span.start >= end) break;
			nextSpan += 1;
			const current = open[open.length - 1];
			if (current !== undefined && span.start >= current.bodyStart) {
				current.spans.push(span);
			}
		}
	};

	for (const match of xml.matchAll(paragraphTags)) {
		const at = match.index ?? 0;
		assignSpansBefore(at);
		if (match[1] === "/") {
			open.pop();
			continue;
		}
		if (match[2] === "/") continue;
		const frame = {
			order: frames.length,
			bodyStart: at + match[0].length,
			spans: [] as ReturnType<typeof findTextSpans>,
		};
		frames.push(frame);
		open.push(frame);
	}
	assignSpansBefore(xml.length);

	return frames
		.filter((frame) => frame.spans.length > 0)
		.sort((left, right) => left.order - right.order)
		.map((frame, index) => ({ part, index, spans: frame.spans }));
}

/** A paragraph together with the text read from it. */
interface ReadParagraph extends Paragraph {
	readonly text: string;
}

/** Read every translatable paragraph of an OOXML package. */
function readParagraphs(
	entries: PackageEntries,
	format: DocumentFormat,
): ReadParagraph[] {
	const spec = SPECS[format];
	if (spec === undefined) return [];

	const result: ReadParagraph[] = [];

	for (const path of entryPathsMatching(entries, /./)) {
		if (!spec.partPatterns.some((pattern) => pattern.test(path))) continue;

		const xml = readTextEntry(entries, path);
		if (xml === undefined) continue;

		for (const paragraph of paragraphsIn(path, xml, spec)) {
			const text = joinSpans(paragraph.spans);
			if (text.trim() === "") continue;
			result.push({ ...paragraph, text });
		}
	}

	return result;
}

/**
 * Parse an OOXML document into chunks.
 *
 * One chunk per paragraph. Splitting a long paragraph across several model calls is
 * the chunker's job (`chunk.ts`), which keeps this layer's unit crisp: a paragraph
 * is a place the text can be written back to.
 */
export function parseOoxml(
	bytes: Uint8Array,
	format: DocumentFormat,
): ParsedDocument {
	const spec = SPECS[format];
	if (spec === undefined) {
		throw new Error(`${format} 不是 OOXML 格式`);
	}

	const entries = readPackage(bytes);
	const paragraphs = readParagraphs(entries, format);

	const chunks: TextChunk[] = paragraphs.map((paragraph) => ({
		id: `${paragraph.part}:${paragraph.index}:0`,
		text: paragraph.text,
		location: { part: paragraph.part, paragraph: paragraph.index, segment: 0 },
	}));

	return { format, chunks };
}

/** Replacement for one chunk, addressed by its location. */
export interface ChunkReplacement {
	readonly location: {
		readonly part?: string;
		readonly paragraph: number;
		readonly segment: number;
	};
	readonly target: string;
}

/**
 * Rebuild an OOXML package with the given translations applied.
 *
 * Returns the new bytes plus the paths that were actually changed, so a caller can
 * report which parts were touched without re-reading the package.
 */
export function rebuildOoxml(
	bytes: Uint8Array,
	format: DocumentFormat,
	replacements: readonly ChunkReplacement[],
): { readonly bytes: Uint8Array; readonly changedParts: readonly string[] } {
	const spec = SPECS[format];
	if (spec === undefined) {
		throw new Error(`${format} 不是 OOXML 格式`);
	}

	const entries = readPackage(bytes);
	const changedParts: string[] = [];

	// Group by part so each part is read, edited and written exactly once.
	const byPart = new Map<string, ChunkReplacement[]>();
	for (const replacement of replacements) {
		if (replacement.location.part === undefined) continue;
		const list = byPart.get(replacement.location.part) ?? [];
		list.push(replacement);
		byPart.set(replacement.location.part, list);
	}

	for (const [path, partReplacements] of byPart) {
		const xml = readTextEntry(entries, path);
		if (xml === undefined) continue;

		const paragraphs = paragraphsIn(path, xml, spec);
		const paragraphByIndex = new Map(
			paragraphs.map((paragraph) => [paragraph.index, paragraph] as const),
		);
		const edits: {
			span: ReturnType<typeof findTextSpans>[number];
			value: string;
		}[] = [];

		for (const replacement of partReplacements) {
			const paragraph = paragraphByIndex.get(replacement.location.paragraph);
			if (paragraph === undefined) continue;

			// Segment 0 means the paragraph is whole. A paragraph split into several
			// segments by the chunker cannot be written back per segment, because the
			// translated pieces would each need run placement; the joined translation
			// is written instead by the caller arriving here once per paragraph.
			const replaceable = paragraph.spans.filter((span) => !span.selfClosing);
			if (replaceable.length === 0) continue;

			// Translation goes in the first text element; the rest are emptied. Splitting
			// it back across runs would break words, which is exactly what must not
			// happen.
			edits.push({ span: replaceable[0], value: replacement.target });
			for (const span of replaceable.slice(1)) {
				edits.push({ span, value: "" });
			}
		}

		if (edits.length === 0) continue;

		const next = replaceTextSpans(xml, edits);

		// A rebuild that produced broken markup must not be delivered.
		if (!isWellFormed(next)) {
			throw new Error(`重建后的 ${path} 结构不合法`);
		}

		writeTextEntry(entries, path, next);
		changedParts.push(path);
	}

	return { bytes: writePackage(entries), changedParts };
}
