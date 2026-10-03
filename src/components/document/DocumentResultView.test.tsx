/** @vitest-environment jsdom */

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DocumentResultView } from "./DocumentResultView";

describe("document delivery view", () => {
	it("shows the PDF layout disclosure before the download action", () => {
		const html = renderToString(
			<DocumentResultView
				format="pdf"
				downloadUrl="blob:pdf"
				downloadName="report.zh-Hans.pdf"
			/>,
		);
		expect(html).toContain("PDF 无法保留原排版");
		expect(html.indexOf("PDF 无法保留原排版")).toBeLessThan(
			html.indexOf("report.zh-Hans.pdf"),
		);
	});

	it("does not show a PDF warning for an OOXML delivery", () => {
		const html = renderToString(
			<DocumentResultView
				format="docx"
				downloadUrl="blob:docx"
				downloadName="report.zh-Hans.docx"
			/>,
		);
		expect(html).not.toContain("无法保留原排版");
		expect(html).toContain("report.zh-Hans.docx");
	});

	it("explains an empty document without a download link", () => {
		const html = renderToString(
			<DocumentResultView
				format="pdf"
				empty
				downloadUrl="blob:empty"
				downloadName="empty.zh-Hans.pdf"
			/>,
		);
		expect(html).toContain("未在这份文档中找到可翻译的文本");
		expect(html).not.toContain("empty.zh-Hans.pdf");
	});
});
