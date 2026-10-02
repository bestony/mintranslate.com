import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createGlossaryStore,
	type GlossaryStore,
	type GlossaryTerm,
	matchGlossaryTerms,
	openGlossaryDatabase,
	parseGlossaryPayload,
	toCsv,
} from "./index";

let store: GlossaryStore;

beforeEach(() => {
	store = createGlossaryStore({ factory: new IDBFactory() });
});

function term(
	partial: Partial<GlossaryTerm> &
		Pick<GlossaryTerm, "source" | "target" | "sl" | "tl">,
): GlossaryTerm {
	return {
		id: partial.id ?? partial.source,
		source: partial.source,
		target: partial.target,
		sl: partial.sl,
		tl: partial.tl,
		caseSensitive: partial.caseSensitive ?? false,
		note: partial.note ?? "",
		priority: partial.priority ?? 0,
		createdAt: partial.createdAt ?? 1,
		updatedAt: partial.updatedAt ?? 1,
	};
}

describe("glossary schema and CRUD", () => {
	it("opens its own database and object stores", async () => {
		const opened = await openGlossaryDatabase(new IDBFactory());
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.db.name).toBe("mintranslate-glossary");
		expect(opened.db.objectStoreNames.contains("terms")).toBe(true);
		expect(opened.db.objectStoreNames.contains("versions")).toBe(true);
	});

	it("creates, reads, updates and removes terms", async () => {
		const added = await store.add({
			source: "  API   Gateway ",
			target: "网关",
			sl: "en",
			tl: "zh-Hans",
			note: "network",
			priority: 2,
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.term.source).toBe("API Gateway");

		const read = await store.get(added.term.id);
		expect(read.ok).toBe(true);
		if (!read.ok || read.value === undefined) return;
		expect(read.value.target).toBe("网关");

		const updated = await store.update(added.term.id, { target: "网络网关" });
		expect(updated.ok).toBe(true);
		const listed = await store.list({ sl: "en", tl: "zh-Hans" });
		expect(listed.ok).toBe(true);
		if (listed.ok) expect(listed.value[0]?.target).toBe("网络网关");

		const removed = await store.delete(added.term.id);
		expect(removed).toEqual({ ok: true, value: true });
	});

	it("rejects normalized duplicates and changes the pair version", async () => {
		const pair = { sl: "en", tl: "zh-Hans" };
		const before = await store.getVersion(pair);
		expect(
			(await store.add({ source: "Hello", target: "你好", ...pair })).ok,
		).toBe(true);
		const after = await store.getVersion(pair);
		expect(after).not.toBe(before);
		const duplicate = await store.add({
			source: " hello ",
			target: "您好",
			...pair,
		});
		expect(duplicate.ok).toBe(false);
	});

	it("includes wildcard source terms and clears only the requested pair", async () => {
		const beforeConcrete = await store.getVersion({ sl: "en", tl: "zh-Hans" });
		await store.add({
			source: "cache",
			target: "缓存",
			sl: "auto",
			tl: "zh-Hans",
		});
		expect(await store.getVersion({ sl: "en", tl: "zh-Hans" })).not.toBe(
			beforeConcrete,
		);
		await store.add({ source: "cache", target: "cache", sl: "en", tl: "fr" });
		const listed = await store.list({ sl: "en", tl: "zh-Hans" });
		expect(listed.ok && listed.value).toHaveLength(1);
		const cleared = await store.clear({ sl: "en", tl: "zh-Hans" });
		expect(cleared).toEqual({ ok: true, value: 1 });
		const remaining = await store.list();
		expect(remaining.ok && remaining.value).toHaveLength(1);
	});
});

describe("glossary transfer", () => {
	it("round-trips CSV quoting and JSON fields", async () => {
		await store.add({
			source: "A, term",
			target: "译\n文",
			sl: "en",
			tl: "zh-Hans",
			note: 'say "exactly"',
			priority: 4,
		});
		const csv = await store.export("csv");
		expect(csv.ok).toBe(true);
		if (!csv.ok) return;
		const parsed = parseGlossaryPayload(csv.value.content, "csv");
		expect(parsed.ok).toBe(true);
		if (parsed.ok)
			expect(parsed.records[0]).toMatchObject({ source: "A, term" });

		const json = await store.export("json");
		expect(json.ok).toBe(true);
		if (!json.ok) return;
		expect(json.value.content).toContain('"priority": 4');
		expect(json.value.content.toLowerCase()).not.toContain("apikey");
	});

	it("reports skip and overwrite conflicts", async () => {
		await store.add({ source: "term", target: "old", sl: "en", tl: "zh-Hans" });
		const csv = toCsv([
			term({ source: "term", target: "new", sl: "en", tl: "zh-Hans" }),
		]);
		const skipped = await store.import(csv, {
			format: "csv",
			conflict: "skip",
		});
		expect(skipped.ok && skipped.value.conflicts).toBe(1);
		const overwritten = await store.import(csv, {
			format: "csv",
			conflict: "overwrite",
		});
		expect(overwritten.ok && overwritten.value.updated).toBe(1);
		const list = await store.list({ sl: "en", tl: "zh-Hans" });
		expect(list.ok && list.value[0]?.target).toBe("new");
	});

	it("counts invalid imported records", async () => {
		const result = await store.import(
			JSON.stringify({
				terms: [{ source: "", target: "x", sl: "en", tl: "zh" }],
			}),
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.invalid).toBe(1);
	});
});

describe("Aho-Corasick matching", () => {
	it("handles case, Latin boundaries, CJK text and overlap", () => {
		const terms = [
			term({ source: "cat", target: "猫", sl: "en", tl: "zh-Hans" }),
			term({
				source: "API",
				target: "接口",
				sl: "en",
				tl: "zh-Hans",
				caseSensitive: true,
			}),
			term({ source: "New", target: "新", sl: "en", tl: "zh-Hans" }),
			term({ source: "New York", target: "纽约", sl: "en", tl: "zh-Hans" }),
			term({ source: "术语", target: "term", sl: "zh-Hans", tl: "en" }),
		];
		const matches = matchGlossaryTerms(
			"A cat CAT concatenate API api New York 这是术语测试",
			{ sl: "en", tl: "zh-Hans" },
			terms,
		);
		expect(matches.map((match) => match.target)).toEqual([
			"猫",
			"猫",
			"接口",
			"纽约",
		]);
		const cjk = matchGlossaryTerms(
			"这是术语测试",
			{ sl: "zh-Hans", tl: "en" },
			terms,
		);
		expect(cjk[0]?.target).toBe("term");
	});

	it("supports auto source and the empty table", () => {
		const wildcard = term({
			source: "memo",
			target: "记忆",
			sl: "auto",
			tl: "zh-Hans",
		});
		const concrete = term({
			source: "memo",
			target: "具体",
			sl: "en",
			tl: "zh-Hans",
		});
		expect(
			matchGlossaryTerms("memo", { sl: "fr", tl: "zh-Hans" }, [wildcard]),
		).toHaveLength(1);
		const autoMatches = matchGlossaryTerms(
			"memo",
			{ sl: "auto", tl: "zh-Hans" },
			[wildcard, concrete],
		);
		expect(autoMatches).toEqual(
			expect.arrayContaining([expect.objectContaining({ target: "记忆" })]),
		);
		expect(autoMatches).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ target: "具体" })]),
		);
		expect(matchGlossaryTerms("memo", { sl: "en", tl: "zh-Hans" }, [])).toEqual(
			[],
		);
	});

	it("matches 5000 terms in a bounded time", () => {
		const terms = Array.from({ length: 5000 }, (_, index) =>
			term({
				id: `term-${index}`,
				source: `term-${index}`,
				target: `译-${index}`,
				sl: "en",
				tl: "zh-Hans",
			}),
		);
		const text = `${"filler ".repeat(1500)} term-4999`;
		const started = performance.now();
		const matches = matchGlossaryTerms(
			text,
			{ sl: "en", tl: "zh-Hans" },
			terms,
		);
		const elapsed = performance.now() - started;
		expect(matches.map((match) => match.target)).toContain("译-4999");
		expect(elapsed).toBeLessThan(1500);
	});
});
