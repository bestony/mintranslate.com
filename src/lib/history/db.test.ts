import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearAll,
	countRecords,
	DEFAULT_RECORD_LIMIT,
	deleteRecord,
	deleteRecords,
	evictOverLimit,
	INDEX_DEDUPE,
	INDEX_FAVORITE,
	INDEX_LANGPAIR,
	INDEX_UPDATED,
	openHistoryDatabase,
	RECORDS_STORE,
	readAll,
	readByIds,
	readPage,
	searchRecords,
	setFavorite,
	transactionAsPromise,
	writeRecord,
} from "./db";
import {
	clampSourceText,
	dedupeKey,
	isWithinLimit,
	validateRecord,
} from "./model";

/**
 * These tests drive a real IndexedDB implementation (`fake-indexeddb`), so the
 * things under test are genuinely exercised: index key paths, cursor direction,
 * and the unique constraint on the dedupe index. A hand-written stub could only
 * prove that the stub is self-consistent.
 */

let db: IDBDatabase;

beforeEach(async () => {
	// A brand-new in-memory factory per test. Deleting a shared database instead
	// would require every prior connection to be closed, and a single stray
	// connection makes `deleteDatabase` block forever — an isolated factory
	// removes that class of flakiness entirely.
	const opened = await openHistoryDatabase(new IDBFactory());
	if (!opened.ok)
		throw new Error(`database unavailable in test: ${opened.reason}`);
	db = opened.db;
});

/** Insert a record with explicit timestamps for deterministic ordering. */
async function seed(options: {
	readonly source: string;
	readonly target: string;
	readonly sourceLang?: string;
	readonly targetLang?: string;
	readonly at: number;
	readonly detectedLang?: string;
}) {
	return writeRecord(
		db,
		{
			sourceText: options.source,
			targetText: options.target,
			sourceLang: options.sourceLang ?? "auto",
			targetLang: options.targetLang ?? "en",
			model: "test-model",
			...(options.detectedLang !== undefined && {
				detectedLang: options.detectedLang,
			}),
		},
		options.at,
	);
}

describe("schema", () => {
	it("creates the store and all four indexes", () => {
		const transaction = db.transaction(RECORDS_STORE, "readonly");
		const store = transaction.objectStore(RECORDS_STORE);

		expect(store.keyPath).toBe("id");
		expect([...store.indexNames].sort()).toEqual(
			[INDEX_DEDUPE, INDEX_FAVORITE, INDEX_LANGPAIR, INDEX_UPDATED].sort(),
		);
	});

	it("enforces uniqueness on the dedupe index", async () => {
		// The constraint is what makes "no duplicates" a storage guarantee rather
		// than a convention the write path must remember. IndexedDB reports the
		// violation when the transaction aborts, not from `put` synchronously.
		const transaction = db.transaction(RECORDS_STORE, "readwrite");
		const store = transaction.objectStore(RECORDS_STORE);
		const base = {
			updatedAt: 1,
			sourceText: "",
			targetText: "",
			sourceLang: "a",
			targetLang: "b",
			model: "",
			favorite: false,
			favoriteFlag: 0,
			createdAt: 1,
		};
		store.put({ ...base, id: "one", dedupeKey: "same" });
		store.put({ ...base, id: "two", dedupeKey: "same" });

		await expect(transactionAsPromise(transaction)).rejects.toBeTruthy();
	});

	it("reports unavailable when IndexedDB is absent", async () => {
		const opened = await openHistoryDatabase(undefined);
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.reason).toContain("IndexedDB");
	});

	it("reports unavailable when opening throws", async () => {
		const broken = {
			open: () => {
				throw new Error("blocked by policy");
			},
		} as unknown as IDBFactory;
		const opened = await openHistoryDatabase(broken);
		expect(opened.ok).toBe(false);
	});
});

describe("write path", () => {
	it("inserts a new record", async () => {
		const result = await seed({ source: "hello", target: "你好", at: 1000 });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.inserted).toBe(true);
		expect(await countRecords(db)).toBe(1);
	});

	it("updates instead of inserting for the same dedupe key", async () => {
		await seed({ source: "hello", target: "你好", at: 1000 });
		const second = await seed({
			source: "hello",
			target: "你好（改）",
			at: 2000,
		});

		expect(await countRecords(db)).toBe(1);
		if (second.ok) {
			expect(second.inserted).toBe(false);
			expect(second.record.targetText).toBe("你好（改）");
			expect(second.record.updatedAt).toBe(2000);
		}
	});

	it("folds whitespace differences into the same key", async () => {
		await seed({ source: "hello  world", target: "a", at: 1000 });
		await seed({ source: "  hello world  ", target: "b", at: 2000 });
		expect(await countRecords(db)).toBe(1);
	});

	it("treats a different target language as a different record", async () => {
		await seed({
			source: "hello",
			target: "你好",
			targetLang: "zh-Hans",
			at: 1000,
		});
		await seed({
			source: "hello",
			target: "こんにちは",
			targetLang: "ja",
			at: 2000,
		});
		expect(await countRecords(db)).toBe(2);
	});

	it("collapses auto-detected and explicit source languages", async () => {
		// The user sees the same translation either way, so it is one record.
		await seed({
			source: "hello",
			target: "你好",
			sourceLang: "auto",
			detectedLang: "en",
			at: 1000,
		});
		await seed({ source: "hello", target: "你好", sourceLang: "en", at: 2000 });
		expect(await countRecords(db)).toBe(1);
	});

	it("keeps records without a detected language separate from a detected one", async () => {
		await seed({
			source: "hello",
			target: "你好",
			sourceLang: "auto",
			at: 1000,
		});
		await seed({
			source: "hello",
			target: "你好",
			sourceLang: "auto",
			detectedLang: "en",
			at: 2000,
		});
		// Different keys: "unknown" is not the same fact as "detected en".
		expect(await countRecords(db)).toBe(2);
	});

	it("stores no credential-shaped field", async () => {
		await seed({ source: "x", target: "y", at: 1000 });
		const [record] = await readAll(db);

		// `dedupeKey` is an internal identity field, not a credential, so the
		// check targets credential-shaped names rather than the substring "key".
		for (const key of Object.keys(record)) {
			const lowered = key.toLowerCase();
			expect(lowered).not.toContain("apikey");
			expect(lowered).not.toContain("api_key");
			expect(lowered).not.toContain("token");
			expect(lowered).not.toContain("secret");
			expect(lowered).not.toContain("authorization");
			expect(lowered).not.toBe("key");
		}
	});

	it("keeps an optional duration and omits TTFT", async () => {
		await writeRecord(
			db,
			{
				sourceText: "a",
				targetText: "b",
				sourceLang: "auto",
				targetLang: "en",
				model: "m",
				durationMs: 1234,
			},
			1000,
		);
		const [record] = await readAll(db);
		expect(record.durationMs).toBe(1234);
		expect("ttftMs" in record).toBe(false);
	});
});

describe("eviction", () => {
	it("removes the oldest non-favourites beyond the limit", async () => {
		for (let index = 0; index < 5; index += 1) {
			await seed({ source: `text-${index}`, target: "t", at: 1000 + index });
		}

		const removed = await evictOverLimit(db, 3);
		expect(removed).toBe(2);
		expect(await countRecords(db)).toBe(3);

		const remaining = await readAll(db);
		const sources = remaining.map((r) => r.sourceText).sort();
		// The two oldest went; the three newest stayed.
		expect(sources).toEqual(["text-2", "text-3", "text-4"]);
	});

	it("never evicts a favourite", async () => {
		await seed({ source: "oldest", target: "t", at: 1000 });
		const [oldest] = await readAll(db);
		await setFavorite(db, oldest.id, true);

		for (let index = 0; index < 4; index += 1) {
			await seed({ source: `later-${index}`, target: "t", at: 2000 + index });
		}

		await evictOverLimit(db, 3);
		const remaining = await readAll(db);
		expect(remaining.map((r) => r.sourceText)).toContain("oldest");
	});

	it("does nothing when within the limit", async () => {
		await seed({ source: "a", target: "t", at: 1000 });
		expect(await evictOverLimit(db, 10)).toBe(0);
	});

	it("leaves records untouched when every one is a favourite", async () => {
		for (let index = 0; index < 3; index += 1) {
			await seed({ source: `fav-${index}`, target: "t", at: 1000 + index });
		}
		for (const record of await readAll(db))
			await setFavorite(db, record.id, true);

		expect(await evictOverLimit(db, 1)).toBe(0);
		expect(await countRecords(db)).toBe(3);
	});

	it("uses the documented default limit", () => {
		expect(DEFAULT_RECORD_LIMIT).toBe(1000);
	});
});

describe("favourites and deletion", () => {
	it("persists and clears the favourite flag", async () => {
		await seed({ source: "a", target: "t", at: 1000 });
		const [record] = await readAll(db);

		await setFavorite(db, record.id, true);
		expect((await readAll(db))[0].favorite).toBe(true);

		await setFavorite(db, record.id, false);
		expect((await readAll(db))[0].favorite).toBe(false);
	});

	it("removes a single record", async () => {
		await seed({ source: "a", target: "t", at: 1000 });
		const [record] = await readAll(db);

		expect(await deleteRecord(db, record.id)).toBe(true);
		expect(await countRecords(db)).toBe(0);
	});

	it("removes many records", async () => {
		for (let index = 0; index < 4; index += 1) {
			await seed({ source: `t${index}`, target: "t", at: 1000 + index });
		}
		const all = await readAll(db);
		expect(await deleteRecords(db, [all[0].id, all[1].id])).toBe(2);
		expect(await countRecords(db)).toBe(2);
	});

	it("clears every record", async () => {
		for (let index = 0; index < 3; index += 1) {
			await seed({ source: `t${index}`, target: "t", at: 1000 + index });
		}
		expect(await clearAll(db)).toBe(true);
		expect(await countRecords(db)).toBe(0);
	});
});

describe("pagination", () => {
	beforeEach(async () => {
		for (let index = 0; index < 10; index += 1) {
			await seed({ source: `text-${index}`, target: "t", at: 1000 + index });
		}
	});

	it("returns newest first", async () => {
		const page = await readPage(db, { limit: 3 });
		expect(page.records.map((r) => r.sourceText)).toEqual([
			"text-9",
			"text-8",
			"text-7",
		]);
	});

	it("reports more pages available", async () => {
		const page = await readPage(db, { limit: 3 });
		expect(page.hasMore).toBe(true);
	});

	it("reports no more pages at the end", async () => {
		const page = await readPage(db, { limit: 10 });
		expect(page.records).toHaveLength(10);
		expect(page.hasMore).toBe(false);
	});

	it("honours an offset", async () => {
		const page = await readPage(db, { offset: 2, limit: 2 });
		expect(page.records.map((r) => r.sourceText)).toEqual(["text-7", "text-6"]);
	});

	it("never exceeds the requested page size", async () => {
		const page = await readPage(db, { limit: 1 });
		expect(page.records).toHaveLength(1);
	});

	it("filters by time range", async () => {
		const page = await readPage(db, {
			limit: 20,
			filter: { since: 1004, until: 1006 },
		});
		expect(page.records.map((r) => r.updatedAt)).toEqual([1006, 1005, 1004]);
	});

	it("filters by language pair through the compound index", async () => {
		await seed({
			source: "other",
			target: "t",
			sourceLang: "fr",
			targetLang: "de",
			at: 5000,
		});
		const page = await readPage(db, {
			limit: 20,
			filter: { sourceLang: "fr", targetLang: "de" },
		});
		expect(page.records.map((r) => r.sourceText)).toEqual(["other"]);
	});

	it("filters to favourites only", async () => {
		const all = await readAll(db);
		await setFavorite(db, all[0].id, true);
		const page = await readPage(db, {
			limit: 20,
			filter: { favoritesOnly: true },
		});
		expect(page.records).toHaveLength(1);
		expect(page.records[0].id).toBe(all[0].id);
	});
});

describe("keyword search", () => {
	beforeEach(async () => {
		// Hits at both ends of the scan order, with non-matches between: this is
		// what distinguishes a complete scan from a first-page-only one.
		await seed({ source: "needle at the newest", target: "t9", at: 1009 });
		await seed({ source: "filler 8", target: "t8", at: 1008 });
		await seed({ source: "filler 7", target: "t7", at: 1007 });
		await seed({ source: "filler 6", target: "t6", at: 1006 });
		await seed({ source: "filler 5", target: "t5", at: 1005 });
		await seed({ source: "the oldest needle", target: "t1", at: 1001 });
	});

	it("finds matches in the source text", async () => {
		const result = await searchRecords(db, "needle");
		expect(result.records.map((r) => r.sourceText)).toEqual([
			"needle at the newest",
			"the oldest needle",
		]);
	});

	it("finds matches in the target text", async () => {
		const result = await searchRecords(db, "t1");
		expect(result.records.map((r) => r.targetText)).toContain("t1");
	});

	it("returns hits that lie beyond the first page of records", async () => {
		// The decisive assertion: a match near the end of the scan must appear.
		const result = await searchRecords(db, "oldest");
		expect(result.records.map((r) => r.sourceText)).toEqual([
			"the oldest needle",
		]);
	});

	it("searches case-insensitively", async () => {
		const result = await searchRecords(db, "NEEDLE");
		expect(result.records).toHaveLength(2);
	});

	it("stops scanning once a page of matches is collected", async () => {
		const result = await searchRecords(db, "", { limit: 2 });
		// Two matches collected from the two newest records: no need to walk the rest.
		expect(result.records).toHaveLength(2);
		expect(result.scanned).toBe(2);
	});

	it("scans as far as needed when matches are sparse", async () => {
		const result = await searchRecords(db, "oldest");
		// Had to pass the fillers to reach it.
		expect(result.scanned).toBe(6);
	});

	it("combines with other filters", async () => {
		const result = await searchRecords(db, "filler", {
			filter: { favoritesOnly: true },
		});
		expect(result.records).toHaveLength(0);
	});

	it("reports an empty result rather than an error when nothing matches", async () => {
		const result = await searchRecords(db, "absent");
		expect(result.records).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	it("supports paging through matches", async () => {
		const first = await searchRecords(db, "filler", { limit: 2 });
		expect(first.records).toHaveLength(2);
		expect(first.hasMore).toBe(true);

		const second = await searchRecords(db, "filler", { offset: 2, limit: 2 });
		expect(second.records).toHaveLength(2);
		expect(second.records[0].updatedAt).toBeLessThan(
			first.records[1].updatedAt,
		);
	});
});

describe("bulk reads", () => {
	it("reads every record for export", async () => {
		for (let index = 0; index < 5; index += 1) {
			await seed({ source: `t${index}`, target: "t", at: 1000 + index });
		}
		// Export must not be limited by the UI page size.
		expect(await readAll(db)).toHaveLength(5);
	});

	it("reads specific records by id", async () => {
		for (let index = 0; index < 3; index += 1) {
			await seed({ source: `t${index}`, target: "t", at: 1000 + index });
		}
		const all = await readAll(db);
		const selected = await readByIds(db, [all[0].id, all[2].id]);
		expect(selected).toHaveLength(2);
		expect(selected.map((r) => r.sourceText).sort()).toEqual(["t0", "t2"]);
	});

	it("returns nothing for an empty id list", async () => {
		expect(await readByIds(db, [])).toEqual([]);
	});
});

describe("pure model helpers", () => {
	it("clamps over-long source text", () => {
		const long = "a".repeat(6000);
		expect(clampSourceText(long)).toHaveLength(5000);
		expect(isWithinLimit(long)).toBe(false);
		expect(isWithinLimit("short")).toBe(true);
	});

	it("rejects malformed records", () => {
		expect(validateRecord(null).ok).toBe(false);
		expect(validateRecord({}).ok).toBe(false);
		expect(validateRecord({ sourceText: "a" }).ok).toBe(false);
		expect(
			validateRecord({
				sourceText: "  ",
				targetText: "b",
				sourceLang: "en",
				targetLang: "ja",
			}).ok,
		).toBe(false);
	});

	it("accepts and truncates a valid record", () => {
		const result = validateRecord({
			sourceText: "a".repeat(6000),
			targetText: "b",
			sourceLang: "en",
			targetLang: "ja",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.record.sourceText).toHaveLength(5000);
	});

	it("ignores an invalid detected language type", () => {
		const result = validateRecord({
			sourceText: "a",
			targetText: "b",
			sourceLang: "auto",
			targetLang: "ja",
			detectedLang: 42,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.record.detectedLang).toBeUndefined();
	});

	it("builds different keys for different language pairs", () => {
		const base = { sourceText: "hello", sourceLang: "auto" };
		expect(dedupeKey({ ...base, targetLang: "en" })).not.toBe(
			dedupeKey({ ...base, targetLang: "ja" }),
		);
	});
});
