/**
 * History export and import.
 *
 * Two constraints shape this module:
 *
 * - **No credential can leave.** The export path reads only history records, and
 *   this module does not import the credential storage at all. Secret isolation
 *   is therefore structural: there is no code path that could include a key even
 *   by mistake (design.md D7).
 * - **Imported content is text.** Records are validated for type and length and
 *   nothing else — no HTML or Markdown parsing, no sanitising that would rewrite
 *   what the user exported. Rendering escapes on the React side.
 *
 * CSV is offered alongside JSON because a table tool is how most people actually
 * inspect a backup.
 */

import { type HistoryRecord, validateRecord } from "./model";

/** Export scopes offered to the user. */
export type ExportScope = "all" | "selected";

/** Cell separator; a tab is not used because spreadsheets read `,` by default. */
const CSV_DELIMITER = ",";
const CSV_NEWLINE = "\r\n";

/** Column order, fixed so an import can rely on the header. */
const CSV_COLUMNS = [
	"sourceText",
	"targetText",
	"sourceLang",
	"targetLang",
	"model",
	"favorite",
	"createdAt",
	"updatedAt",
] as const;

/**
 * Escape one CSV field.
 *
 * A field is quoted when it contains the delimiter, a quote or a line break.
 * Embedded quotes are doubled, which is the convention spreadsheet tools expect.
 */
export function escapeCsvField(value: string): string {
	const needsQuoting =
		value.includes(CSV_DELIMITER) ||
		value.includes('"') ||
		/[\r\n]/.test(value);

	if (!needsQuoting) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

/** Render one record as a CSV row. */
function toCsvRow(record: HistoryRecord): string {
	const values: Record<(typeof CSV_COLUMNS)[number], string> = {
		sourceText: record.sourceText,
		targetText: record.targetText,
		sourceLang: record.sourceLang,
		targetLang: record.targetLang,
		model: record.model,
		favorite: record.favorite ? "true" : "false",
		createdAt: String(record.createdAt),
		updatedAt: String(record.updatedAt),
	};

	return CSV_COLUMNS.map((column) => escapeCsvField(values[column])).join(
		CSV_DELIMITER,
	);
}

/** Build a CSV document from records. */
export function toCsv(records: readonly HistoryRecord[]): string {
	const header = CSV_COLUMNS.join(CSV_DELIMITER);
	const rows = records.map(toCsvRow);
	return [header, ...rows].join(CSV_NEWLINE);
}

/**
 * Parse a CSV document into rows.
 *
 * Handles quoted fields containing the delimiter, doubled quotes and embedded
 * newlines, so a round trip through a spreadsheet does not corrupt text.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];

		if (inQuotes) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					// Escaped quote.
					field += '"';
					index += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"') {
			inQuotes = true;
		} else if (char === CSV_DELIMITER) {
			row.push(field);
			field = "";
		} else if (char === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (char === "\r") {
			// Part of a CRLF pair; the LF branch handles the row break.
		} else {
			field += char;
		}
	}

	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

/** Outcome of parsing an import payload. */
export type ParseResult =
	| {
			readonly ok: true;
			readonly records: readonly unknown[];
			readonly skipped: number;
			readonly reasons: readonly string[];
	  }
	| { readonly ok: false; readonly reason: string };

/** Parse a JSON export payload. */
export function parseJsonExport(text: string): ParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "文件不是合法的 JSON" };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, reason: "文件结构不是预期格式" };
	}

	const container = parsed as { records?: unknown };
	if (!Array.isArray(container.records)) {
		return { ok: false, reason: "文件中缺少记录数组" };
	}

	// Individual records are validated later, by the same routine the store uses.
	return { ok: true, records: container.records, skipped: 0, reasons: [] };
}

/** Parse a CSV export produced by this module or by a spreadsheet. */
export function parseCsvExport(text: string): ParseResult {
	const rows = parseCsv(text).filter((row) =>
		row.some((cell) => cell.trim() !== ""),
	);
	if (rows.length === 0) {
		return { ok: false, reason: "文件为空" };
	}

	const header = rows[0].map((cell) => cell.trim());
	const indexOf = (name: string) => header.indexOf(name);

	// The identifying columns must be present; anything else is ignored rather
	// than failing the whole file.
	for (const required of [
		"sourceText",
		"targetText",
		"sourceLang",
		"targetLang",
	]) {
		if (indexOf(required) === -1) {
			return { ok: false, reason: `缺少必需列：${required}` };
		}
	}

	const reasons: string[] = [];
	const records: unknown[] = [];
	let skipped = 0;

	for (const row of rows.slice(1)) {
		const pick = (name: string) => {
			const at = indexOf(name);
			return at === -1 ? undefined : row[at];
		};

		const record = {
			sourceText: pick("sourceText") ?? "",
			targetText: pick("targetText") ?? "",
			sourceLang: pick("sourceLang") ?? "",
			targetLang: pick("targetLang") ?? "",
			model: pick("model") ?? "",
		};

		// Reuse the shared validator so CSV and JSON imports cannot diverge.
		const validated = validateRecord(record);
		if (validated.ok) records.push(record);
		else {
			skipped += 1;
			if (reasons.length < 5) reasons.push(validated.reason);
		}
	}

	return { ok: true, records, skipped, reasons };
}

/** Detected payload kind. */
export type PayloadKind = "json" | "csv";

/**
 * Guess the payload kind from its content.
 *
 * Content-based rather than extension-based: a user may rename a file, and the
 * first meaningful character is a reliable signal for these two formats.
 */
export function detectPayloadKind(text: string): PayloadKind {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
	return "csv";
}

/** Suggested file name for an export. */
export function exportFileName(kind: PayloadKind, at: Date): string {
	const stamp = at.toISOString().slice(0, 10);
	return `mintranslate-history-${stamp}.${kind}`;
}

/** MIME type for a download. */
export function exportMimeType(kind: PayloadKind): string {
	return kind === "json" ? "application/json" : "text/csv";
}

/**
 * Filter records for an export scope.
 *
 * `selected` keeps the given ids; `all` keeps everything. There is deliberately
 * no "current filter result" scope — two unambiguous options are easier to
 * explain than three.
 */
export function selectForExport(
	records: readonly HistoryRecord[],
	scope: ExportScope,
	selectedIds: readonly string[] = [],
): readonly HistoryRecord[] {
	if (scope === "all") return records;
	const wanted = new Set(selectedIds);
	return records.filter((record) => wanted.has(record.id));
}
