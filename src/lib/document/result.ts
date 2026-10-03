/**
 * Delivered result: file name and the layout disclosure.
 *
 * Kept apart from parsing because it is the user-facing half of the contract — what
 * they get and what they are told before they get it.
 */

import { type DocumentFormat, deliversTextOnly } from "./model";
import { extensionOf } from "./validate";

/**
 * Name for a delivered file.
 *
 * Only the **last** extension is treated as the extension: `2026.03.report.docx`
 * has a base name containing dots, and stripping at the first dot would deliver
 * `2026.zh-Hans.docx` — a different document's name.
 */
export function deliveredFileName(
	originalName: string,
	targetLang: string,
): string {
	const extension = extensionOf(originalName);
	const base =
		extension === ""
			? originalName
			: originalName.slice(0, originalName.length - extension.length - 1);
	return `${base}.${targetLang}.${extension}`;
}

/**
 * Whether the layout disclosure must be shown for this format.
 *
 * Only PDFs lose their layout: the other three are rebuilt in place, so telling
 * their users that "formatting will be lost" would be false.
 */
export function needsLayoutDisclosure(format: DocumentFormat): boolean {
	return deliversTextOnly(format);
}

/** The disclosure text for a format that loses its layout. */
export function layoutDisclosure(format: DocumentFormat): string | undefined {
	if (!needsLayoutDisclosure(format)) return undefined;
	return "PDF 无法保留原排版：交付内容为原文与译文的对照文本，可直接下载查看。";
}

/** What to say when a document yielded no translatable text. */
export const EMPTY_DOCUMENT_NOTICE =
	"未在这份文档中找到可翻译的文本。若它是扫描件（页面是图片），本功能无法提取文字。";

/** Comparison text for a text-only delivery: page by page, source then target. */
export function buildComparisonText(
	pages: readonly {
		readonly page: number;
		readonly pairs: readonly (readonly [string, string])[];
	}[],
): string {
	return pages
		.map((entry) => {
			const lines = entry.pairs.map(
				([source, target]) => `${source}\n${target}`,
			);
			return [`— 第 ${entry.page} 页 —`, ...lines].join("\n");
		})
		.join("\n\n");
}
