/** CSV and JSON transfer helpers for glossary records. */

import {
	type ExportFormat,
	type GlossaryTerm,
	toExportableTerm,
} from "./model";

export const GLOSSARY_EXPORT_VERSION = 1;
export const GLOSSARY_CSV_COLUMNS = [
	"source",
	"target",
	"sl",
	"tl",
	"note",
] as const;

export type ParsedGlossaryPayload =
	| {
			readonly ok: true;
			readonly records: readonly unknown[];
			readonly errors: readonly string[];
	  }
	| { readonly ok: false; readonly reason: string };

export function escapeCsvField(value: string): string {
	if (!/[",\r\n]/.test(value)) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(terms: readonly GlossaryTerm[]): string {
	const rows = terms.map((term) =>
		[term.source, term.target, term.sl, term.tl, term.note]
			.map(escapeCsvField)
			.join(","),
	);
	return [GLOSSARY_CSV_COLUMNS.join(","), ...rows].join("\r\n");
}

/** Parse RFC-style CSV fields, including quoted newlines and escaped quotes. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && field === "") quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (char !== "\r") field += char;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function parseCsvPayload(text: string): ParsedGlossaryPayload {
	const rows = parseCsv(text).filter((row) =>
		row.some((cell) => cell.trim() !== ""),
	);
	if (rows.length === 0) return { ok: false, reason: "文件为空" };
	const header = rows[0].map((cell) => cell.trim());
	const positions = GLOSSARY_CSV_COLUMNS.map((column) =>
		header.indexOf(column),
	);
	const missing = GLOSSARY_CSV_COLUMNS.findIndex(
		(_, index) => positions[index] < 0,
	);
	if (missing >= 0)
		return {
			ok: false,
			reason: `缺少必需列：${GLOSSARY_CSV_COLUMNS[missing]}`,
		};

	const records: unknown[] = [];
	const errors: string[] = [];
	for (const row of rows.slice(1)) {
		const value = (index: number): string => row[positions[index]] ?? "";
		const record = {
			source: value(0),
			target: value(1),
			sl: value(2),
			tl: value(3),
			note: value(4),
		};
		// Syntax parsing and semantic validation stay separate. The store receives
		// every row so it can count invalid records in its import report.
		records.push(record);
	}
	return { ok: true, records, errors };
}

function parseJsonPayload(text: string): ParsedGlossaryPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "文件不是合法的 JSON" };
	}
	if (Array.isArray(parsed)) return { ok: true, records: parsed, errors: [] };
	if (typeof parsed !== "object" || parsed === null)
		return { ok: false, reason: "文件结构不是预期格式" };
	const records = (parsed as { terms?: unknown }).terms;
	if (!Array.isArray(records))
		return { ok: false, reason: "文件中缺少 terms 数组" };
	return { ok: true, records, errors: [] };
}

export function parseGlossaryPayload(
	text: string,
	format: ExportFormat = text.trimStart().startsWith("{") ||
	text.trimStart().startsWith("[")
		? "json"
		: "csv",
): ParsedGlossaryPayload {
	return format === "json" ? parseJsonPayload(text) : parseCsvPayload(text);
}

export function toJson(terms: readonly GlossaryTerm[]): string {
	return JSON.stringify(
		{
			version: GLOSSARY_EXPORT_VERSION,
			terms: terms.map(toExportableTerm),
		},
		null,
		2,
	);
}

export function serializeGlossary(
	terms: readonly GlossaryTerm[],
	format: ExportFormat,
): string {
	return format === "csv" ? toCsv(terms) : toJson(terms);
}
