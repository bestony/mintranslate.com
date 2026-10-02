/**
 * Local document operations shared by the Worker and the main-thread fallback.
 *
 * This module deliberately has no provider, fetch, or DOM dependency. The input
 * is already in memory and the only work performed here is local parsing,
 * chunking, and rebuilding. Keeping one operation function is what makes the
 * Worker and fallback paths equivalent rather than two implementations that can
 * drift apart.
 */

import { chunkDocument } from "./chunk";
import { extractPdfText, type PdfExtraction } from "./pdf";
import {
	parseOoxml,
	rebuildOoxml,
	type ChunkReplacement,
} from "./ooxml";
import type { DocumentFormat, ParsedDocument, TextChunk } from "./model";

export type DocumentJob =
	| {
			readonly kind: "parse";
			readonly bytes: Uint8Array;
			readonly format: Exclude<DocumentFormat, "pdf">;
	  }
	| {
			readonly kind: "rebuild";
			readonly bytes: Uint8Array;
			readonly format: Exclude<DocumentFormat, "pdf">;
			readonly replacements: readonly ChunkReplacement[];
	  }
	| { readonly kind: "extract-pdf"; readonly bytes: Uint8Array };

export type DocumentJobResult =
	| { readonly kind: "parsed"; readonly document: ParsedDocument }
	| {
			readonly kind: "rebuilt";
			readonly bytes: Uint8Array;
			readonly changedParts: readonly string[];
	  }
	| { readonly kind: "pdf"; readonly extraction: PdfExtraction };

/** Execute one local document operation. No network path exists in this code. */
export async function processDocumentJob(
	job: DocumentJob,
): Promise<DocumentJobResult> {
	if (job.kind === "parse") {
		const parsed = parseOoxml(job.bytes, job.format);
		const chunks = chunkDocument(
			parsed.chunks.map((chunk) => ({
				text: chunk.text,
				location: chunk.location,
			})),
		);
		return {
			kind: "parsed",
			document: { ...parsed, chunks },
		};
	}

	if (job.kind === "rebuild") {
		const rebuilt = rebuildOoxml(job.bytes, job.format, job.replacements);
		return { kind: "rebuilt", ...rebuilt };
	}

	return { kind: "pdf", extraction: await extractPdfText(job.bytes) };
}

/** Type guard used by callers that dispatch several operation kinds. */
export function isTextDocumentResult(
	result: DocumentJobResult,
): result is Extract<DocumentJobResult, { readonly kind: "parsed" }> {
	return result.kind === "parsed";
}

/** Keep the worker protocol's public types free of implementation-only imports. */
export type { ChunkReplacement, PdfExtraction, TextChunk };
