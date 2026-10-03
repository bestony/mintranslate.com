/** @vitest-environment node */

import { describe, expect, it } from "vitest";
import { pdfComparisonText, replacementsFromTask } from "./delivery";
import type { TextChunk } from "./model";
import { createTaskRecord } from "./task-store";

function record(
	chunks: readonly TextChunk[],
	targets: readonly (string | undefined)[],
) {
	return createTaskRecord({
		id: "delivery",
		fileName: "a.docx",
		format: "docx",
		sourceLang: "en",
		targetLang: "zh-Hans",
		styleId: "free",
		chunks: chunks.map((chunk, index) => ({
			chunk,
			target: targets[index],
		})),
		now: 1,
	});
}

describe("document delivery", () => {
	it("joins split OOXML paragraph targets in segment order", () => {
		const chunks: TextChunk[] = [
			{
				id: "p:0:1",
				text: " world",
				location: { part: "word/document.xml", paragraph: 0, segment: 1 },
			},
			{
				id: "p:0:0",
				text: "Hello",
				location: { part: "word/document.xml", paragraph: 0, segment: 0 },
			},
		];

		expect(replacementsFromTask(record(chunks, [" world!", "你好"]))).toEqual([
			{
				location: { part: "word/document.xml", paragraph: 0, segment: 0 },
				target: "你好 world!",
			},
		]);
	});

	it("leaves a paragraph out while one of its chunks is incomplete", () => {
		const chunk: TextChunk = {
			id: "p:0:0",
			text: "Hello",
			location: { part: "word/document.xml", paragraph: 0, segment: 0 },
		};
		expect(replacementsFromTask(record([chunk], [undefined]))).toEqual([]);
	});

	it("renders PDF source and target pairs in page order", () => {
		const chunks: TextChunk[] = [
			{
				id: "page:2:0:0",
				text: "second",
				location: { page: 2, paragraph: 0, segment: 0 },
			},
			{
				id: "page:1:0:0",
				text: "first",
				location: { page: 1, paragraph: 0, segment: 0 },
			},
		];
		const text = pdfComparisonText(
			{
				pageCount: 2,
				hasText: true,
				pages: [
					{ page: 1, paragraphs: ["first"], text: "first" },
					{ page: 2, paragraphs: ["second"], text: "second" },
				],
			},
			record(chunks, ["第二页", "第一页"]),
		);

		expect(text.indexOf("第 1 页")).toBeLessThan(text.indexOf("第 2 页"));
		expect(text).toContain("first\n第一页");
		expect(text).toContain("second\n第二页");
	});
});
