/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { chunksFromPdfExtraction, extractPdfText } from "./pdf";

function fakeDocument(
	pages: readonly (readonly { str: string; hasEOL?: boolean }[])[],
) {
	return {
		numPages: pages.length,
		getPage: async (page: number) => ({
			getTextContent: async () => ({ items: pages[page - 1] ?? [] }),
		}),
	};
}

describe("PDF text extraction", () => {
	it("keeps page order and preserves empty pages", async () => {
		const result = await extractPdfText(new Uint8Array([1]), {
			loadDocument: async () =>
				fakeDocument([
					[{ str: "第一页", hasEOL: true }, { str: "第一段" }],
					[],
					[{ str: "第三页" }],
				]),
		});

		expect(result.pageCount).toBe(3);
		expect(result.pages.map((page) => page.page)).toEqual([1, 2, 3]);
		expect(result.pages.map((page) => page.paragraphs)).toEqual([
			["第一页", "第一段"],
			[],
			["第三页"],
		]);
		expect(result.hasText).toBe(true);
	});

	it("reports a textless PDF without manufacturing a result", async () => {
		const result = await extractPdfText(new Uint8Array([1]), {
			loadDocument: async () => fakeDocument([[], []]),
		});

		expect(result.hasText).toBe(false);
		expect(result.pages).toHaveLength(2);
		expect(chunksFromPdfExtraction(result)).toEqual([]);
	});

	it("creates one-based page locations for translated chunks", async () => {
		const result = await extractPdfText(new Uint8Array([1]), {
			loadDocument: async () =>
				fakeDocument([[{ str: "Page one" }], [{ str: "Page two" }]]),
		});

		expect(
			chunksFromPdfExtraction(result).map((chunk) => chunk.location),
		).toEqual([
			{ page: 1, paragraph: 0, segment: 0 },
			{ page: 2, paragraph: 0, segment: 0 },
		]);
	});
});
