import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
	buildJsonExport,
	buildMemoryFingerprint,
	buildTmxExport,
	DEFAULT_MEMORY_LIMIT,
	diceCoefficient,
	getNgrams,
	MEMORY_NGRAMS_STORE,
	MEMORY_RECORDS_STORE,
	openTranslationMemoryDatabase,
	pairTranslationSegments,
	parseTmxExport,
	TRANSLATION_MEMORY_DATABASE_NAME,
	TranslationMemoryStore,
	validateMemoryInput,
} from ".";

let store: TranslationMemoryStore;

beforeEach(async () => {
	const opened = await openTranslationMemoryDatabase(new IDBFactory());
	if (!opened.ok) throw new Error(opened.reason);
	store = new TranslationMemoryStore({ db: opened.db });
});

function memoryInput(
	sourceText: string,
	targetText = `译-${sourceText}`,
	options: Partial<{
		sl: string;
		tl: string;
		glossaryVersion: string;
		styleId: string;
		tier: string;
		origin: "model" | "user-edit" | "import";
	}> = {},
) {
	return {
		sourceText,
		targetText,
		sl: options.sl ?? "en",
		tl: options.tl ?? "zh-Hans",
		glossaryVersion: options.glossaryVersion ?? "none",
		styleId: options.styleId ?? "literal",
		tier: options.tier ?? "fast",
		origin: options.origin ?? "model",
	};
}

describe("model and key boundaries", () => {
	it("normalizes NFC and folded whitespace", async () => {
		const composed = "café";
		const decomposed = "cafe\u0301";
		const first = buildMemoryFingerprint("  hello  world ", memoryInput("x"));
		const second = buildMemoryFingerprint("hello world", memoryInput("x"));
		expect(first).toBe(second);
		expect(buildMemoryFingerprint(decomposed, memoryInput("x"))).toBe(
			buildMemoryFingerprint(composed, memoryInput("x")),
		);
	});

	it("uses bigrams for CJK and trigrams for Latin", () => {
		expect(getNgrams("你好世界")).toEqual(["你好", "好世", "世界"]);
		expect(getNgrams("abcdef")).toEqual(["abc", "bcd", "cde", "def"]);
		expect(diceCoefficient(["你好", "好世"], ["你好", "世好"])).toBe(0.5);
	});

	it("pairs equal segments and falls back to whole text", () => {
		expect(pairTranslationSegments("One. Two.", "一。 二。")).toEqual([
			{ sourceText: "One.", targetText: "一。" },
			{ sourceText: "Two.", targetText: "二。" },
		]);
		expect(pairTranslationSegments("One. Two.", "一段完整译文")).toEqual([
			{ sourceText: "One. Two.", targetText: "一段完整译文" },
		]);
	});

	it("validates imports and clamps the source limit", () => {
		const result = validateMemoryInput({
			sourceText: "x".repeat(6000),
			targetText: "y",
			sl: "en",
			tl: "zh-Hans",
		});
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(Array.from(result.input.sourceText)).toHaveLength(5000);
		expect(validateMemoryInput({ sourceText: "x" }).ok).toBe(false);
	});
});

describe("IndexedDB store", () => {
	it("uses an independent database and both object stores", () => {
		expect(store.db.name).toBe(TRANSLATION_MEMORY_DATABASE_NAME);
		const transaction = store.db.transaction(
			[MEMORY_RECORDS_STORE, MEMORY_NGRAMS_STORE],
			"readonly",
		);
		expect(
			transaction.objectStore(MEMORY_RECORDS_STORE).indexNames.length,
		).toBeGreaterThan(3);
		expect(transaction.objectStore(MEMORY_NGRAMS_STORE).indexNames.length).toBe(
			2,
		);
	});

	it("writes, exact-hits and increments hit metadata", async () => {
		const written = await store.put(memoryInput("hello", "你好"));
		expect(written.ok).toBe(true);
		const found = await store.findExact(memoryInput("  hello "));
		expect(found?.targetText).toBe("你好");
		expect(found?.hitCount).toBe(1);
		expect(found?.lastHitAt).toBeTypeOf("number");
	});

	it("keeps forced hash collisions separate", async () => {
		const opened = await openTranslationMemoryDatabase(new IDBFactory());
		if (!opened.ok) throw new Error(opened.reason);
		const collisionStore = new TranslationMemoryStore({
			db: opened.db,
			hash: () => "same-hash",
		});
		await collisionStore.put(memoryInput("first"));
		await collisionStore.put(memoryInput("second"));
		expect(await collisionStore.readAll()).toHaveLength(2);
		expect(
			(await collisionStore.findExact(memoryInput("first")))?.sourceText,
		).toBe("first");
	});

	it("queries source and target through the n-gram index", async () => {
		await store.put(memoryInput("needle at newest", "最新"));
		await store.put(memoryInput("filler text", "普通"));
		await store.put(memoryInput("old needle", "旧"));
		const result = await store.query({
			filter: { keyword: "NEEDLE" },
			limit: 10,
		});
		expect(result.records.map((record) => record.sourceText)).toEqual([
			"old needle",
			"needle at newest",
		]);
	});

	it("supports combined filters, paging and similarity", async () => {
		await store.put(memoryInput("alpha one", "甲", { origin: "import" }));
		await store.put(memoryInput("alpha two", "乙"));
		await store.put(memoryInput("beta", "丙", { sl: "fr" }));
		const page = await store.query({
			filter: { sl: "en", origin: "model", keyword: "alpha" },
			limit: 1,
		});
		expect(page.records.length).toBeLessThanOrEqual(3);
		expect(page.hasMore).toBe(false);
		const similar = await store.findSimilar(
			"alpha one",
			{ sl: "en", tl: "zh-Hans" },
			{
				threshold: 0.5,
				limit: 3,
			},
		);
		expect(similar[0]?.record.sourceText).toBe("alpha one");
	});

	it("pages in index order and reports local statistics", async () => {
		const first = await store.put(memoryInput("first", "一"));
		await store.put(memoryInput("second", "二", { tl: "ja" }));
		await store.put(memoryInput("third", "三"));
		if (!first.ok) throw new Error(first.reason);
		await store.findExact(memoryInput("first"));
		const page = await store.query({ limit: 2 });
		expect(page.records).toHaveLength(2);
		expect(page.hasMore).toBe(true);
		if (!page.nextCursor) throw new Error("expected a continuation cursor");
		const next = await store.query({ limit: 2, cursor: page.nextCursor });
		expect(next.records).toHaveLength(1);
		const stats = await store.stats();
		expect(stats.total).toBe(3);
		expect(stats.byLanguagePair["en\u0000zh-Hans"]).toBe(2);
		expect(stats.hitRate).toBeCloseTo(1 / 3);
	});

	it("protects user edits and evicts model records first", async () => {
		const clock = { value: 1000 };
		const opened = await openTranslationMemoryDatabase(new IDBFactory());
		if (!opened.ok) throw new Error(opened.reason);
		const limited = new TranslationMemoryStore({
			db: opened.db,
			maxRecords: 2,
			now: () => clock.value,
		});
		await limited.put(memoryInput("model-old"));
		const edit = await limited.put(
			memoryInput("user-old", "用户译", { origin: "user-edit" }),
		);
		expect(edit.ok).toBe(true);
		clock.value = 2000;
		await limited.put(memoryInput("model-new"));
		const kept = await limited.readAll();
		expect(kept.map((record) => record.sourceText).sort()).toEqual([
			"model-new",
			"user-old",
		]);
		const protectedWrite = await limited.put(
			memoryInput("user-old", "模型覆盖"),
		);
		expect(protectedWrite.ok && protectedWrite.protectedUserEdit).toBe(true);
		expect((await limited.findExact(memoryInput("user-old")))?.targetText).toBe(
			"用户译",
		);
		expect(DEFAULT_MEMORY_LIMIT).toBe(20000);
	});

	it("updates and deletes n-gram entries", async () => {
		const written = await store.put(memoryInput("old text"));
		if (!written.ok) throw new Error(written.reason);
		const updated = await store.update(written.record.id, {
			targetText: "new target",
		});
		expect(updated.ok).toBe(true);
		expect(
			(await store.query({ filter: { keyword: "译-old" } })).records,
		).toHaveLength(0);
		expect(
			(await store.query({ filter: { keyword: "new target" } })).records,
		).toHaveLength(1);
		expect(await store.delete(written.record.id)).toBe(true);
		expect(
			(await store.query({ filter: { keyword: "new target" } })).records,
		).toHaveLength(0);
	});

	it("deletes a batch without leaving indexed candidates", async () => {
		const first = await store.put(memoryInput("batch-one"));
		const second = await store.put(memoryInput("batch-two"));
		if (!first.ok || !second.ok) throw new Error("seed failed");
		expect(await store.deleteMany([first.record.id, second.record.id])).toBe(2);
		expect(
			(await store.query({ filter: { keyword: "batch" } })).records,
		).toHaveLength(0);
	});

	it("round-trips JSON and TMX as plain text", async () => {
		await store.put(memoryInput("<b>hello</b>", "<script>alert(1)</script>"));
		const json = await store.exportJson();
		const tmx = await store.exportTmx();
		expect(JSON.parse(json).schemaVersion).toBe(1);
		expect(tmx).toContain('version="1.4"');
		const parsedTmx = parseTmxExport(tmx);
		expect(parsedTmx.ok).toBe(true);
		if (parsedTmx.ok) {
			expect(parsedTmx.records[0]).toMatchObject({
				sourceText: "<b>hello</b>",
				targetText: "<script>alert(1)</script>",
			});
		}
		const otherOpened = await openTranslationMemoryDatabase(new IDBFactory());
		if (!otherOpened.ok) throw new Error(otherOpened.reason);
		const other = new TranslationMemoryStore({ db: otherOpened.db });
		const imported = await other.importJson(json);
		expect(imported.imported).toBe(1);
		expect((await other.readAll())[0]?.targetText).toContain("script");
		expect(buildJsonExport(await other.readAll())).toContain("schemaVersion");
		expect(buildTmxExport(await other.readAll())).toContain("<tu");
	});
});

describe("performance guard", () => {
	it("queries and finds similar in a 20000-record store within the test budget", async () => {
		const opened = await openTranslationMemoryDatabase(new IDBFactory());
		if (!opened.ok) throw new Error(opened.reason);
		const large = new TranslationMemoryStore({ db: opened.db });
		await large.putMany(
			Array.from({ length: 20_000 }, (_, index) =>
				memoryInput("x", "y", { styleId: `style-${index}` }),
			),
		);
		const queryStart = performance.now();
		const page = await large.query({ filter: { keyword: "x" }, limit: 3 });
		const queryMs = performance.now() - queryStart;
		const similarStart = performance.now();
		const similar = await large.findSimilar(
			"x",
			{ sl: "en", tl: "zh-Hans" },
			{ threshold: 0.8 },
		);
		const similarMs = performance.now() - similarStart;
		expect(page.records.length).toBeLessThanOrEqual(3);
		expect(similar.length).toBeGreaterThan(0);
		expect(queryMs).toBeLessThan(5000);
		expect(similarMs).toBeLessThan(5000);
	}, 30_000);
});
