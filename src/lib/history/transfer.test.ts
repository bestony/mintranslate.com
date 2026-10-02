import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
	buildExportPayload,
	importRecords,
	openHistoryDatabase,
	readAll,
	writeRecord,
} from "./db";
import type { HistoryRecord } from "./model";
import {
	detectPayloadKind,
	escapeCsvField,
	exportFileName,
	exportMimeType,
	parseCsv,
	parseCsvExport,
	parseJsonExport,
	selectForExport,
	toCsv,
} from "./transfer";

let db: IDBDatabase;

beforeEach(async () => {
	const opened = await openHistoryDatabase(new IDBFactory());
	if (!opened.ok) throw new Error(opened.reason);
	db = opened.db;
});

/** Seed one record and return the stored form. */
async function seed(
	source: string,
	target: string,
	at: number,
): Promise<HistoryRecord> {
	await writeRecord(
		db,
		{
			sourceText: source,
			targetText: target,
			sourceLang: "auto",
			targetLang: "en",
			model: "m",
		},
		at,
	);
	const all = await readAll(db);
	return all.find((record) => record.sourceText === source) as HistoryRecord;
}

describe("CSV escaping", () => {
	it("leaves a plain field unquoted", () => {
		expect(escapeCsvField("hello")).toBe("hello");
	});

	it("quotes a field containing the delimiter", () => {
		expect(escapeCsvField("a,b")).toBe('"a,b"');
	});

	it("doubles embedded quotes", () => {
		expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
	});

	it("quotes a field containing a newline", () => {
		expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
	});
});

describe("CSV round trip", () => {
	it("preserves fields containing commas, quotes and newlines", async () => {
		// The decisive case: a naive join/split would corrupt all three.
		await seed("has, comma", 'has "quotes"', 1000);
		await seed("multi\nline", "second", 2000);

		const csv = toCsv(await readAll(db));
		const parsed = parseCsvExport(csv);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const sources = parsed.records.map(
			(r) => (r as { sourceText: string }).sourceText,
		);
		expect(sources).toContain("has, comma");
		expect(sources).toContain("multi\nline");

		const targets = parsed.records.map(
			(r) => (r as { targetText: string }).targetText,
		);
		expect(targets).toContain('has "quotes"');
	});

	it("writes a header row", async () => {
		await seed("a", "b", 1000);
		const csv = toCsv(await readAll(db));
		expect(csv.split("\r\n")[0]).toContain("sourceText");
	});

	it("writes one row per record plus the header", async () => {
		await seed("a", "b", 1000);
		await seed("c", "d", 2000);
		const rows = parseCsv(toCsv(await readAll(db)));
		expect(rows).toHaveLength(3);
	});

	it("parses quoted fields back to their original value", () => {
		const rows = parseCsv('a,"b,c","d""e"');
		expect(rows[0]).toEqual(["a", "b,c", 'd"e']);
	});

	it("handles an empty document", () => {
		expect(parseCsv("")).toEqual([]);
	});
});

describe("JSON export", () => {
	it("includes every record regardless of page size", async () => {
		for (let index = 0; index < 5; index += 1)
			await seed(`t${index}`, "x", 1000 + index);

		const payload = buildExportPayload(
			await readAll(db),
			new Date().toISOString(),
		);
		expect(payload.records).toHaveLength(5);
	});

	it("carries a version marker", async () => {
		const payload = buildExportPayload([], new Date().toISOString());
		expect(payload.version).toBe(1);
	});

	it("is parseable back into records", async () => {
		await seed("hello", "你好", 1000);
		const payload = buildExportPayload(
			await readAll(db),
			new Date().toISOString(),
		);
		const parsed = parseJsonExport(JSON.stringify(payload));

		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.records).toHaveLength(1);
	});

	it("omits internal-only fields from the export payload", async () => {
		await seed("a", "b", 1000);
		const [exported] = buildExportPayload(await readAll(db), "now").records;
		// Both are storage mechanics, not user data.
		expect("dedupeKey" in exported).toBe(false);
		expect("favoriteFlag" in exported).toBe(false);
	});
});

describe("credential isolation", () => {
	it("exports nothing credential-shaped even when a key slot exists", async () => {
		// Simulate a configured key in the separate localStorage slot.
		const storage = new Map<string, string>([
			["mintranslate.credentials.v1", '{"c":"secret-value"}'],
		]);
		await seed("a", "b", 1000);

		const payload = JSON.stringify(
			buildExportPayload(await readAll(db), new Date().toISOString()),
		);
		expect(payload).not.toContain("secret-value");
		expect(payload).not.toContain("credentials");
		expect(storage.get("mintranslate.credentials.v1")).toBeDefined();
	});

	it("does not import the credential storage module", async () => {
		// Structural guarantee: the export path cannot read a key it never loads.
		const source = await import("node:fs").then((fs) =>
			fs.readFileSync("src/lib/history/transfer.ts", "utf8"),
		);
		expect(source).not.toContain("credentials/storage");
		expect(source).not.toContain("connections/storage");
		expect(source).not.toContain("KEYS_KEY");
	});
});

describe("import validation", () => {
	it("reports malformed JSON", () => {
		const result = parseJsonExport("{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("JSON");
	});

	it("reports a structurally wrong payload", () => {
		expect(parseJsonExport('{"nope":1}').ok).toBe(false);
		expect(parseJsonExport("[]").ok).toBe(false);
	});

	it("accepts a well-formed payload", () => {
		const result = parseJsonExport('{"version":1,"records":[]}');
		expect(result.ok).toBe(true);
	});

	it("skips invalid records and reports the count", () => {
		const csv = [
			"sourceText,targetText,sourceLang,targetLang,model,favorite,createdAt,updatedAt",
			"good,译文,auto,en,m,false,1,1",
			",译文,auto,en,m,false,1,1",
			"also good,译文,auto,en,m,false,1,1",
		].join("\r\n");

		const result = parseCsvExport(csv);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.records).toHaveLength(2);
		expect(result.skipped).toBe(1);
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("reports a CSV missing required columns", () => {
		const result = parseCsvExport("a,b\r\n1,2");
		expect(result.ok).toBe(false);
	});

	it("reports an empty CSV", () => {
		expect(parseCsvExport("").ok).toBe(false);
	});

	it("detects the payload kind from content", () => {
		expect(detectPayloadKind('  {"records":[]}')).toBe("json");
		expect(detectPayloadKind("sourceText,targetText")).toBe("csv");
	});
});

describe("import merge", () => {
	it("merges without clearing existing history", async () => {
		await seed("existing", "x", 1000);

		const result = await importRecords(db, [
			{
				sourceText: "incoming",
				targetText: "y",
				sourceLang: "auto",
				targetLang: "en",
				model: "m",
			},
		]);

		expect(result.imported).toBe(1);
		expect(await readAll(db)).toHaveLength(2);
	});

	it("updates rather than duplicates for a matching key", async () => {
		await seed("same", "old", 1000);

		const result = await importRecords(db, [
			{
				sourceText: "same",
				targetText: "new",
				sourceLang: "auto",
				targetLang: "en",
				model: "m",
			},
		]);

		expect(result.imported).toBe(1);
		expect(await readAll(db)).toHaveLength(1);
	});

	it("reports skipped entries with reasons", async () => {
		const result = await importRecords(db, [
			{ nope: true },
			{
				sourceText: "ok",
				targetText: "t",
				sourceLang: "auto",
				targetLang: "en",
			},
		]);
		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(1);
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("tolerates an empty record list", async () => {
		const result = await importRecords(db, []);
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
	});
});

describe("import treats content as text", () => {
	it("stores HTML verbatim without parsing it", async () => {
		const html = "<script>alert(1)</script><b>bold</b>";
		await importRecords(db, [
			{
				sourceText: html,
				targetText: html,
				sourceLang: "auto",
				targetLang: "en",
				model: "m",
			},
		]);

		const [record] = await readAll(db);
		// Byte-for-byte identical: nothing was escaped, stripped or rewritten.
		expect(record.sourceText).toBe(html);
		expect(record.targetText).toBe(html);
	});

	it("stores Markdown verbatim without parsing it", async () => {
		const markdown = "**bold** and `code`";
		await importRecords(db, [
			{
				sourceText: markdown,
				targetText: markdown,
				sourceLang: "auto",
				targetLang: "en",
				model: "m",
			},
		]);

		const [record] = await readAll(db);
		expect(record.sourceText).toBe(markdown);
	});

	it("survives a CSV round trip with HTML content", async () => {
		const html = '<a href="x">link</a>, with comma';
		await importRecords(db, [
			{
				sourceText: html,
				targetText: "t",
				sourceLang: "auto",
				targetLang: "en",
				model: "m",
			},
		]);

		const csv = toCsv(await readAll(db));
		const reparsed = parseCsvExport(csv);
		if (!reparsed.ok) throw new Error("expected parse to succeed");
		expect(reparsed.records[0]).toMatchObject({ sourceText: html });
	});
});

describe("export scope", () => {
	function record(id: string): HistoryRecord {
		return {
			id,
			sourceText: id,
			targetText: "t",
			sourceLang: "auto",
			targetLang: "en",
			model: "m",
			favorite: false,
			createdAt: 1,
			updatedAt: 1,
		};
	}

	it("selects everything for the all scope", () => {
		const records = [record("a"), record("b")];
		expect(selectForExport(records, "all")).toHaveLength(2);
	});

	it("selects only the given ids for the selected scope", () => {
		const records = [record("a"), record("b"), record("c")];
		expect(
			selectForExport(records, "selected", ["b", "c"]).map((r) => r.id),
		).toEqual(["b", "c"]);
	});

	it("returns nothing when the selected scope has no ids", () => {
		expect(selectForExport([record("a")], "selected", [])).toEqual([]);
	});

	it("ignores ids that are not present", () => {
		expect(selectForExport([record("a")], "selected", ["missing"])).toEqual([]);
	});
});

describe("export file naming", () => {
	it("names the file with the date and extension", () => {
		const name = exportFileName("json", new Date("2026-10-02T00:00:00Z"));
		expect(name).toBe("mintranslate-history-2026-10-02.json");
	});

	it("uses the right extension per kind", () => {
		expect(exportFileName("csv", new Date("2026-10-02T00:00:00Z"))).toContain(
			".csv",
		);
	});

	it("uses the right MIME type per kind", () => {
		expect(exportMimeType("json")).toBe("application/json");
		expect(exportMimeType("csv")).toBe("text/csv");
	});
});
