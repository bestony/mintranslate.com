/**
 * PDF text extraction through the locally bundled pdf.js build.
 *
 * The module is loaded only when a PDF is processed. Its worker is constructed
 * from the package's bundled worker entry, so neither the parser nor the worker
 * needs a CDN URL. Tests inject a small document-shaped parser and therefore do
 * not need a browser Worker or a real PDF fixture.
 */

import { withBase } from "../base-path";
import { chunkParagraph } from "./chunk";
import type { TextChunk } from "./model";

export interface PdfTextItem {
	readonly str?: string;
	readonly hasEOL?: boolean;
}

export interface PdfPageLike {
	getTextContent(): Promise<{ readonly items: readonly PdfTextItem[] }>;
}

export interface PdfDocumentLike {
	readonly numPages: number;
	getPage(page: number): Promise<PdfPageLike>;
	destroy?(): Promise<void> | void;
}

export interface PdfExtractionPage {
	readonly page: number;
	/** Paragraphs in reading order. Empty pages remain present. */
	readonly paragraphs: readonly string[];
	readonly text: string;
}

export interface PdfExtraction {
	readonly pageCount: number;
	readonly pages: readonly PdfExtractionPage[];
	readonly hasText: boolean;
}

export interface PdfExtractionDeps {
	readonly loadDocument?: (bytes: Uint8Array) => Promise<PdfDocumentLike>;
}

/** Load pdf.js and attach its bundled worker to a local PDFWorker instance. */
async function loadLocalPdfDocument(
	bytes: Uint8Array,
): Promise<PdfDocumentLike> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

	// The package worker is bundled by Vite as a same-origin asset. Passing a
	// Worker port avoids pdf.js's workerSrc fallback, which is commonly configured
	// to a CDN in examples and would violate the application's offline contract.
	const worker = new Worker(
		new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url),
		{ type: "module" },
	);
	// pdf.js 6's declaration still types the constructor port as `null`, although
	// the runtime accepts a Worker port (and the public PDFWorkerParameters type
	// documents that form). Keep the compatibility cast at this boundary only.
	const pdfWorker = new pdfjs.PDFWorker({ port: worker } as never);
	const loadingTask = pdfjs.getDocument({
		data: bytes,
		worker: pdfWorker,
		cMapUrl: new URL(
			withBase("pdfjs/cmaps/"),
			globalThis.location.origin,
		).toString(),
		cMapPacked: true,
		useSystemFonts: true,
		// The worker fetches same-origin CMaps directly. This keeps the resource
		// request in the PDF worker and avoids any browser-specific Response helper.
		useWorkerFetch: true,
		isOffscreenCanvasSupported: false,
	});

	try {
		const document = await loadingTask.promise;
		return {
			numPages: document.numPages,
			getPage: async (page) => {
				const source = await document.getPage(page);
				return {
					getTextContent: async () => {
						const content = await source.getTextContent();
						return {
							items: content.items
								.filter(
									(item): item is typeof item & { str: string } =>
										typeof (item as { str?: unknown }).str === "string",
								)
								.map((item) => {
									const textItem = item as { str: string; hasEOL?: boolean };
									return { str: textItem.str, hasEOL: textItem.hasEOL };
								}),
						};
					},
				};
			},
			destroy: async () => {
				await loadingTask.destroy();
				pdfWorker.destroy();
				worker.terminate();
			},
		};
	} catch (error) {
		loadingTask.destroy();
		pdfWorker.destroy();
		worker.terminate();
		throw error;
	}
}

/** Convert pdf.js text items into ordered lines without changing page order. */
function linesFromItems(items: readonly PdfTextItem[]): string[] {
	const lines: string[] = [];
	let current = "";
	for (const item of items) {
		const value = item.str ?? "";
		current += value;
		if (item.hasEOL === true) {
			lines.push(current);
			current = "";
		}
	}
	if (current !== "") lines.push(current);
	return lines;
}

/** Extract all pages, retaining empty pages so page numbers remain stable. */
export async function extractPdfText(
	bytes: Uint8Array,
	deps: PdfExtractionDeps = {},
): Promise<PdfExtraction> {
	const document = await (deps.loadDocument ?? loadLocalPdfDocument)(bytes);
	const pages: PdfExtractionPage[] = [];

	try {
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
			const page = await document.getPage(pageNumber);
			const content = await page.getTextContent();
			const lines = linesFromItems(content.items);
			const paragraphs = lines
				.map((line) => line.trim())
				.filter((line) => line !== "");
			pages.push({
				page: pageNumber,
				paragraphs,
				text: paragraphs.join("\n"),
			});
		}
	} finally {
		await document.destroy?.();
	}

	return {
		pageCount: document.numPages,
		pages,
		hasText: pages.some((page) => page.paragraphs.length > 0),
	};
}

/** Turn page paragraphs into chunks while keeping the one-based page location. */
export function chunksFromPdfExtraction(
	extraction: PdfExtraction,
): readonly TextChunk[] {
	const chunks: TextChunk[] = [];
	for (const page of extraction.pages) {
		for (const [paragraph, text] of page.paragraphs.entries()) {
			chunks.push(
				...chunkParagraph(text, {
					page: page.page,
					paragraph,
					segment: 0,
				}),
			);
		}
	}
	return chunks;
}
