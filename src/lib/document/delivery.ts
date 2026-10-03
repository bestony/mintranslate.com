/** Build format-specific delivery data after every chunk has a result. */

import type { DocumentTaskRecord, TextChunk } from "./model";
import type { ChunkReplacement } from "./ooxml";
import type { PdfExtraction } from "./pdf";
import { buildComparisonText } from "./result";

/**
 * Group chunk results back to one OOXML paragraph. A split paragraph is written
 * once, with translated segments joined in source order.
 */
export function replacementsFromTask(
	record: DocumentTaskRecord,
): readonly ChunkReplacement[] {
	const groups = new Map<string, TextChunk[]>();
	for (const entry of record.chunks) {
		const part = entry.chunk.location.part;
		if (part === undefined) continue;
		const key = `${part}:${entry.chunk.location.paragraph}`;
		const list = groups.get(key) ?? [];
		list.push(entry.chunk);
		groups.set(key, list);
	}

	const replacements: ChunkReplacement[] = [];
	for (const chunks of groups.values()) {
		const ordered = [...chunks].sort(
			(left, right) => left.location.segment - right.location.segment,
		);
		const translated = ordered.map(
			(chunk) =>
				record.chunks.find((entry) => entry.chunk.id === chunk.id)?.target,
		);
		if (translated.some((target) => target === undefined)) continue;
		const first = ordered[0];
		if (first === undefined) continue;
		replacements.push({
			location: first.location,
			target: translated.join(""),
		});
	}
	return replacements;
}

/** Build the page-by-page source/target text delivered for a PDF. */
export function pdfComparisonText(
	extraction: PdfExtraction,
	record: DocumentTaskRecord,
): string {
	const byPageParagraph = new Map<string, TextChunk[]>();
	for (const entry of record.chunks) {
		const page = entry.chunk.location.page;
		if (page === undefined) continue;
		const key = `${page}:${entry.chunk.location.paragraph}`;
		const list = byPageParagraph.get(key) ?? [];
		list.push(entry.chunk);
		byPageParagraph.set(key, list);
	}

	return buildComparisonText(
		extraction.pages.map((page) => ({
			page: page.page,
			pairs: page.paragraphs.map((source, paragraph) => {
				const chunks = [
					...(byPageParagraph.get(`${page.page}:${paragraph}`) ?? []),
				].sort((left, right) => left.location.segment - right.location.segment);
				const target = chunks
					.map(
						(chunk) =>
							record.chunks.find((entry) => entry.chunk.id === chunk.id)
								?.target ?? "",
					)
					.join("");
				return [source, target] as const;
			}),
		})),
	);
}
