/**
 * Acceptance and delivery contract.
 *
 * The cases that matter are the ones users hit: a `.doc` file that looks close to
 * `.docx`, a file at exactly the size limit, a scanned PDF with no text layer, and
 * a file name with dots in it. Each has a decided outcome.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import {
	MAX_DOCUMENT_BYTES,
	TASK_BYTE_THRESHOLD,
	TASK_PAGE_THRESHOLD,
} from "./model";
import {
	buildComparisonText,
	deliveredFileName,
	EMPTY_DOCUMENT_NOTICE,
	layoutDisclosure,
	needsLayoutDisclosure,
} from "./result";
import {
	describeBytes,
	taskThresholdNotice,
	taskTrigger,
	unparsableReason,
	validateDocument,
} from "./validate";

const LIMIT = MAX_DOCUMENT_BYTES;

describe("accepted formats", () => {
	it("accepts the four formats", () => {
		for (const [name, format] of [
			["report.docx", "docx"],
			["guide.pdf", "pdf"],
			["deck.pptx", "pptx"],
			["book.xlsx", "xlsx"],
		]) {
			const result = validateDocument({ name, type: "", size: 1024 });
			expect(result.ok, name).toBe(true);
			if (result.ok) expect(result.format).toBe(format);
		}
	});

	it("rejects near-miss formats and names what it accepts", () => {
		for (const name of [
			"old.doc",
			"notes.txt",
			"archive.zip",
			"sheet.ods",
			"extra.docx.bak",
		]) {
			const result = validateDocument({ name, type: "", size: 1024 });
			expect(result.ok, name).toBe(false);
			if (result.ok) continue;
			expect(result.kind).toBe("format");
			expect(result.reason).toContain("docx");
			expect(result.reason).toContain("pdf");
		}
	});

	it("decides by extension, not by the reported type", () => {
		// Browsers report docx variously as the long OOXML type, as application/zip,
		// or as nothing. Judging by type would reject valid files.
		for (const type of [
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"application/zip",
			"",
			"application/octet-stream",
		]) {
			expect(
				validateDocument({ name: "a.docx", type, size: 10 }).ok,
				type,
			).toBe(true);
		}
	});

	it("is case-insensitive about the extension", () => {
		expect(
			validateDocument({ name: "REPORT.DOCX", type: "", size: 10 }).ok,
		).toBe(true);
	});

	it("rejects a file with no extension", () => {
		const result = validateDocument({
			name: "noextension",
			type: "",
			size: 10,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("无扩展名");
	});
});

describe("size limit", () => {
	it("accepts exactly the limit", () => {
		expect(validateDocument({ name: "a.pdf", type: "", size: LIMIT }).ok).toBe(
			true,
		);
	});

	it("rejects one byte over and names both numbers", () => {
		const result = validateDocument({
			name: "a.pdf",
			type: "",
			size: LIMIT + 1,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("size");
		expect(result.reason).toContain("20.0 MB");
	});

	it("rejects an empty file as unreadable", () => {
		const result = validateDocument({ name: "a.pdf", type: "", size: 0 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.kind).toBe("empty");
	});
});

describe("rejection reasons are distinguishable", () => {
	it("gives each cause different text", () => {
		const format = validateDocument({ name: "a.gif", type: "", size: 10 });
		const size = validateDocument({ name: "a.pdf", type: "", size: LIMIT + 1 });
		const empty = validateDocument({ name: "a.pdf", type: "", size: 0 });
		const unparsable = unparsableReason("a.docx");

		const texts = [format, size, empty].map((r) => (r.ok ? "" : r.reason));
		expect(new Set([...texts, unparsable]).size).toBe(4);
	});

	it("does not call a damaged file an unsupported format", () => {
		// The format and size were already acceptable by this point.
		const reason = unparsableReason("a.docx");
		expect(reason).toContain("无法按 docx 格式解析");
		expect(reason).not.toContain("不支持的文档格式");
	});
});

describe("delivered file name", () => {
	it("follows the required pattern", () => {
		expect(deliveredFileName("report.docx", "zh-Hans")).toBe(
			"report.zh-Hans.docx",
		);
	});

	it("keeps dots that belong to the base name", () => {
		// Only the last extension is the extension.
		expect(deliveredFileName("2026.03.report.docx", "zh-Hans")).toBe(
			"2026.03.report.zh-Hans.docx",
		);
	});

	it("keeps the original extension for every format", () => {
		for (const [name, extension] of [
			["a.docx", "docx"],
			["b.pdf", "pdf"],
			["c.pptx", "pptx"],
			["d.xlsx", "xlsx"],
		]) {
			expect(
				deliveredFileName(name, "ja").endsWith(`.ja.${extension}`),
				name,
			).toBe(true);
		}
	});

	it("handles a name with no extension", () => {
		expect(deliveredFileName("plain", "ja")).toBe("plain.ja.");
	});
});

describe("layout disclosure", () => {
	it("is required for pdf only", () => {
		expect(needsLayoutDisclosure("pdf")).toBe(true);
		for (const format of ["docx", "pptx", "xlsx"] as const) {
			expect(needsLayoutDisclosure(format), format).toBe(false);
		}
	});

	it("states the loss for pdf and says nothing for the others", () => {
		expect(layoutDisclosure("pdf")).toContain("无法保留原排版");
		// Telling a docx user their formatting is lost would be false.
		expect(layoutDisclosure("docx")).toBeUndefined();
	});

	it("explains an empty result rather than implying success", () => {
		expect(EMPTY_DOCUMENT_NOTICE).toContain("未在这份文档中找到");
		expect(EMPTY_DOCUMENT_NOTICE).toContain("扫描件");
	});
});

describe("task thresholds", () => {
	it("triggers on page count above the threshold", () => {
		expect(taskTrigger({ size: 100, pageCount: TASK_PAGE_THRESHOLD + 1 })).toBe(
			"pages",
		);
	});

	it("triggers on size above the threshold", () => {
		expect(taskTrigger({ size: TASK_BYTE_THRESHOLD + 1 })).toBe("bytes");
	});

	it("does not trigger at exactly the thresholds", () => {
		expect(
			taskTrigger({
				size: TASK_BYTE_THRESHOLD,
				pageCount: TASK_PAGE_THRESHOLD,
			}),
		).toBe("none");
	});

	it("prefers the page reason when both apply", () => {
		// The page count is the more meaningful explanation for a long document.
		expect(
			taskTrigger({
				size: TASK_BYTE_THRESHOLD * 2,
				pageCount: TASK_PAGE_THRESHOLD + 5,
			}),
		).toBe("pages");
	});

	it("explains both task thresholds to users", () => {
		const notice = taskThresholdNotice();
		expect(notice).toContain("50");
		expect(notice).toContain("2.0 MB");
	});
});

describe("comparison text", () => {
	it("keeps page order and pairs source with target", () => {
		const text = buildComparisonText([
			{ page: 1, pairs: [["Hello", "你好"]] },
			{ page: 2, pairs: [["World", "世界"]] },
		]);
		expect(text.indexOf("第 1 页")).toBeLessThan(text.indexOf("第 2 页"));
		expect(text).toContain("Hello\n你好");
		expect(text).toContain("World\n世界");
	});
});

describe("byte formatting", () => {
	it("formats each scale", () => {
		expect(describeBytes(512)).toBe("512 B");
		expect(describeBytes(2048)).toBe("2 KB");
		expect(describeBytes(MAX_DOCUMENT_BYTES)).toBe("20.0 MB");
	});
});
