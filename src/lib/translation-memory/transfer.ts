/** Versioned JSON and TMX 1.4b transfer helpers. */

import {
	type TranslationMemoryRecord,
	toExportableMemoryRecord,
} from "./model";

export const MEMORY_EXPORT_SCHEMA_VERSION = 1;
export const TMX_VERSION = "1.4";

export interface ImportPayload {
	readonly records: readonly unknown[];
	readonly skipped: number;
	readonly reasons: readonly string[];
}

export type ParseTransferResult =
	| (ImportPayload & { readonly ok: true })
	| { readonly ok: false; readonly reason: string };

/** Build a JSON payload using an explicit field allowlist. */
export function buildJsonExport(
	records: readonly TranslationMemoryRecord[],
	exportedAt: string = new Date().toISOString(),
): string {
	return JSON.stringify(
		{
			schemaVersion: MEMORY_EXPORT_SCHEMA_VERSION,
			// `version` keeps the file self-describing for simple consumers.
			version: MEMORY_EXPORT_SCHEMA_VERSION,
			exportedAt,
			records: records.map(toExportableMemoryRecord),
		},
		null,
		2,
	);
}

/** Parse and structurally validate the JSON envelope. */
export function parseJsonExport(text: string): ParseTransferResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "文件不是合法的 JSON" };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, reason: "文件结构不是预期格式" };
	}
	const value = parsed as {
		schemaVersion?: unknown;
		version?: unknown;
		records?: unknown;
	};
	const version = value.schemaVersion ?? value.version;
	if (version !== MEMORY_EXPORT_SCHEMA_VERSION) {
		return { ok: false, reason: "不支持的翻译记忆 schema 版本" };
	}
	if (!Array.isArray(value.records)) {
		return { ok: false, reason: "文件中缺少记录数组" };
	}
	return { ok: true, records: value.records, skipped: 0, reasons: [] };
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/** Export records as TMX 1.4b, including optional MinTranslate properties. */
export function buildTmxExport(
	records: readonly TranslationMemoryRecord[],
): string {
	const units = records
		.map((record) => {
			const properties = [
				["glossaryVersion", record.glossaryVersion],
				["styleId", record.styleId],
				["tier", record.tier],
				["origin", record.origin],
			]
				.map(
					([name, value]) =>
						`<prop type="mintranslate:${escapeXml(name)}">${escapeXml(value)}</prop>`,
				)
				.join("");
			return [
				`<tu tuid="${escapeXml(record.id)}">`,
				properties,
				`<tuv xml:lang="${escapeXml(record.sl)}"><seg>${escapeXml(record.sourceText)}</seg></tuv>`,
				`<tuv xml:lang="${escapeXml(record.tl)}"><seg>${escapeXml(record.targetText)}</seg></tuv>`,
				"</tu>",
			].join("");
		})
		.join("");

	return [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<tmx version="${TMX_VERSION}"><header creationtool="MinTranslate" segtype="sentence" adminlang="en" srclang="*" o-tmf="mintranslate"/><body>`,
		units,
		"</body></tmx>",
	].join("");
}

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function attribute(element: Element, name: string): string | undefined {
	return (
		element.getAttribute(`xml:${name}`) ??
		element.getAttribute(name) ??
		undefined
	);
}

function parseWithDom(text: string): ParseTransferResult {
	if (typeof DOMParser === "undefined") return parseWithTokens(text);
	const document = new DOMParser().parseFromString(text, "application/xml");
	if (document.querySelector("parsererror")) {
		return { ok: false, reason: "TMX 不是合法的 XML" };
	}

	const records: unknown[] = [];
	const reasons: string[] = [];
	let skipped = 0;
	for (const unit of Array.from(document.querySelectorAll("tu"))) {
		const values = Array.from(unit.querySelectorAll("tuv"))
			.map((tuv) => ({
				lang: attribute(tuv, "lang"),
				text: tuv.querySelector("seg")?.textContent ?? tuv.textContent ?? "",
			}))
			.filter((value) => value.lang !== undefined);
		if (values.length < 2) {
			skipped += 1;
			if (reasons.length < 10) reasons.push("TMX 记录缺少两个语言单元");
			continue;
		}
		const source = values[0];
		const target = values[1];
		if (!source || !target) continue;
		records.push({
			sourceText: source.text,
			targetText: target.text,
			sl: source.lang,
			tl: target.lang,
			origin: "import",
		});
	}
	return { ok: true, records, skipped, reasons };
}

/**
 * Minimal fallback for Node tests. Browser code always takes the DOMParser path;
 * this parser only extracts text and attributes and never evaluates markup.
 */
function parseWithTokens(text: string): ParseTransferResult {
	if (!/<tmx\b[\s\S]*<\/tmx>/i.test(text)) {
		return { ok: false, reason: "TMX 不是合法的 XML" };
	}
	const records: unknown[] = [];
	const reasons: string[] = [];
	let skipped = 0;
	const units = text.match(/<tu\b[^>]*>[\s\S]*?<\/tu>/gi) ?? [];
	for (const unit of units) {
		const values: { lang: string; text: string }[] = [];
		const tuvPattern = /<tuv\b([^>]*)>([\s\S]*?)<\/tuv>/gi;
		for (const match of unit.matchAll(tuvPattern)) {
			const attrs = match[1] ?? "";
			const langMatch = attrs.match(/(?:xml:)?lang\s*=\s*["']([^"']+)["']/i);
			const segMatch = (match[2] ?? "").match(/<seg\b[^>]*>([\s\S]*?)<\/seg>/i);
			if (!langMatch || !segMatch) continue;
			values.push({
				lang: langMatch[1] ?? "",
				text: decodeXml(segMatch[1] ?? ""),
			});
		}
		const source = values[0];
		const target = values[1];
		if (!source || !target || source.lang === "" || target.lang === "") {
			skipped += 1;
			if (reasons.length < 10) reasons.push("TMX 记录缺少两个语言单元");
			continue;
		}
		records.push({
			sourceText: source.text,
			targetText: target.text,
			sl: source.lang,
			tl: target.lang,
			origin: "import",
		});
	}
	return { ok: true, records, skipped, reasons };
}

/** Parse TMX through DOMParser in a browser, with a safe text-only test fallback. */
export function parseTmxExport(text: string): ParseTransferResult {
	return parseWithDom(text);
}

/** Short aliases for callers that use format names as verbs. */
export const exportJson = buildJsonExport;
export const exportTmx = buildTmxExport;
export const importTmx = parseTmxExport;
