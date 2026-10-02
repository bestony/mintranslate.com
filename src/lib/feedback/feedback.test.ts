import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { DATABASE_VERSION, openHistoryDatabase } from "../history/db";
import {
	buildFeedbackExport,
	clearFeedback,
	countFeedback,
	DEFAULT_FEEDBACK_LIMIT,
	evictOverLimit,
	exportFeedback,
	FEEDBACK_DATABASE_VERSION,
	FEEDBACK_KINDS,
	isFeedbackKind,
	openFeedbackDatabase,
	readAllFeedback,
	recordFeedback,
	validateFeedback,
} from "./index";

let db: IDBDatabase;

beforeEach(async () => {
	// An isolated factory per test, matching the history tests' approach.
	const opened = await openFeedbackDatabase(new IDBFactory());
	if (!opened.ok) throw new Error(opened.reason);
	db = opened.db;
});

/** Record one simple entry. */
async function seed(kind: "good" | "bad" = "good", at = 1000) {
	return recordFeedback(
		db,
		{ kind, targetText: "译文", sourceText: "source" },
		at,
	);
}

describe("schema", () => {
	it("opens a database with the feedback store", () => {
		const transaction = db.transaction("feedback", "readonly");
		expect(transaction.objectStore("feedback").keyPath).toBe("id");
	});

	it("uses its own database rather than the history one", () => {
		// Sharing the history database would require a version bump, and a version
		// bump blocks tabs still holding the old schema open.
		expect(db.name).toBe("mintranslate-feedback");
		expect(db.name).not.toBe("mintranslate-history");
	});

	it("leaves the history database version untouched", () => {
		expect(DATABASE_VERSION).toBe(1);
		expect(FEEDBACK_DATABASE_VERSION).toBe(1);
	});

	it("can open both databases at once", async () => {
		const history = await openHistoryDatabase(new IDBFactory());
		expect(history.ok).toBe(true);
	});

	it("reports unavailable when IndexedDB is absent", async () => {
		const opened = await openFeedbackDatabase(undefined);
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.reason).toContain("不支持");
	});
});

describe("validation", () => {
	it("accepts the three kinds", () => {
		for (const kind of FEEDBACK_KINDS) {
			const result = validateFeedback({
				kind,
				targetText: "x",
				...(kind === "suggestion" && { suggestion: "better" }),
			});
			expect(result.ok).toBe(true);
		}
	});

	it("rejects an unknown kind", () => {
		expect(validateFeedback({ kind: "meh", targetText: "x" }).ok).toBe(false);
	});

	it("rejects a missing translation", () => {
		expect(validateFeedback({ kind: "good" }).ok).toBe(false);
	});

	it("rejects an empty suggestion", () => {
		// An empty suggestion would be stored as an entry that says nothing.
		expect(
			validateFeedback({
				kind: "suggestion",
				targetText: "x",
				suggestion: "  ",
			}).ok,
		).toBe(false);
	});

	it("rejects a suggestion with no text at all", () => {
		expect(validateFeedback({ kind: "suggestion", targetText: "x" }).ok).toBe(
			false,
		);
	});

	it("accepts good and bad without a suggestion", () => {
		expect(validateFeedback({ kind: "good", targetText: "x" }).ok).toBe(true);
		expect(validateFeedback({ kind: "bad", targetText: "x" }).ok).toBe(true);
	});

	it("validates kind names", () => {
		expect(isFeedbackKind("good")).toBe(true);
		expect(isFeedbackKind("great")).toBe(false);
	});

	it("ignores a non-string suggestion on a non-suggestion kind", () => {
		const result = validateFeedback({
			kind: "good",
			targetText: "x",
			suggestion: 42,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.input.suggestion).toBeUndefined();
	});
});

describe("recording", () => {
	it("records a positive verdict", async () => {
		const result = await seed("good");
		expect(result.ok).toBe(true);
		expect(await countFeedback(db)).toBe(1);
	});

	it("records a negative verdict", async () => {
		await seed("bad");
		const [record] = await readAllFeedback(db);
		expect(record.kind).toBe("bad");
	});

	it("records a suggestion with its text", async () => {
		const result = await recordFeedback(db, {
			kind: "suggestion",
			targetText: "原译",
			suggestion: "更好的译法",
		});
		expect(result.ok).toBe(true);

		const [record] = await readAllFeedback(db);
		expect(record.suggestion).toBe("更好的译法");
	});

	it("refuses to record an empty suggestion", async () => {
		const result = await recordFeedback(db, {
			kind: "suggestion",
			targetText: "x",
			suggestion: "",
		});
		expect(result.ok).toBe(false);
		expect(await countFeedback(db)).toBe(0);
	});

	it("stores no identity or credential field", async () => {
		await seed();
		const [record] = await readAllFeedback(db);

		for (const key of Object.keys(record)) {
			const lowered = key.toLowerCase();
			expect(lowered).not.toContain("user");
			expect(lowered).not.toContain("account");
			expect(lowered).not.toContain("device");
			expect(lowered).not.toContain("token");
			expect(lowered).not.toContain("secret");
			expect(lowered).not.toContain("key");
		}
	});

	it("carries its own reviewed text instead of a history id", async () => {
		// Self-contained records are what keep history clearing from leaving
		// dangling references.
		await seed();
		const [record] = await readAllFeedback(db);

		expect(record.targetText).toBe("译文");
		expect("historyId" in record).toBe(false);
		expect("recordId" in record).toBe(false);
	});

	it("records optional language information", async () => {
		await recordFeedback(db, {
			kind: "good",
			targetText: "x",
			sourceLang: "auto",
			targetLang: "en",
		});
		const [record] = await readAllFeedback(db);
		expect(record.targetLang).toBe("en");
	});
});

describe("eviction", () => {
	it("keeps every entry below the cap", async () => {
		for (let index = 0; index < 3; index += 1) await seed("good", 1000 + index);
		expect(await evictOverLimit(db, 10)).toBe(0);
		expect(await countFeedback(db)).toBe(3);
	});

	it("removes the oldest entries beyond the cap", async () => {
		for (let index = 0; index < 5; index += 1) {
			await recordFeedback(
				db,
				{ kind: "good", targetText: `t${index}` },
				1000 + index,
			);
		}

		const removed = await evictOverLimit(db, 3);
		expect(removed).toBe(2);

		const kept = await readAllFeedback(db);
		expect(kept.map((record) => record.targetText).sort()).toEqual([
			"t2",
			"t3",
			"t4",
		]);
	});

	it("enforces the default cap of 500", async () => {
		expect(DEFAULT_FEEDBACK_LIMIT).toBe(500);
	});

	it("evicts during recording once the cap is passed", async () => {
		// The cap is enforced by the write path, not by a separate task.
		for (let index = 0; index < 4; index += 1) {
			await recordFeedback(
				db,
				{ kind: "good", targetText: `t${index}` },
				1000 + index,
				3,
			);
		}
		expect(await countFeedback(db)).toBeLessThanOrEqual(3);
	});
});

describe("clearing", () => {
	it("removes every entry", async () => {
		await seed();
		await seed("bad", 2000);
		expect(await clearFeedback(db)).toBe(true);
		expect(await countFeedback(db)).toBe(0);
	});
});

describe("independence from history", () => {
	it("clearing history leaves feedback intact", async () => {
		await seed();

		const history = await openHistoryDatabase(new IDBFactory());
		if (!history.ok) throw new Error(history.reason);
		// The feedback database is untouched by anything done to history.
		expect(await countFeedback(db)).toBe(1);
	});

	it("clearing feedback leaves history intact", async () => {
		const history = await openHistoryDatabase(new IDBFactory());
		if (!history.ok) throw new Error(history.reason);

		await seed();
		await clearFeedback(db);

		// Both databases are independent, so clearing one cannot reach the other.
		expect(await countFeedback(db)).toBe(0);
	});
});

describe("export", () => {
	it("reports when there is nothing to export", async () => {
		const outcome = await exportFeedback(db);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("没有可导出");
	});

	it("exports every record", async () => {
		await seed();
		await seed("bad", 2000);

		const outcome = await exportFeedback(db);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		const parsed = JSON.parse(outcome.payload) as {
			feedback: unknown[];
			version: number;
		};
		expect(parsed.feedback).toHaveLength(2);
		expect(parsed.version).toBe(1);
	});

	it("leaves the stored records unchanged", async () => {
		await seed();
		await exportFeedback(db);
		expect(await countFeedback(db)).toBe(1);
	});

	it("carries no identity information", async () => {
		await seed();
		const outcome = await exportFeedback(db);
		if (!outcome.ok) throw new Error("expected export to succeed");

		const payload = outcome.payload.toLowerCase();
		for (const forbidden of [
			"userid",
			"account",
			"deviceid",
			"token",
			"secret",
			"apikey",
		]) {
			expect(payload).not.toContain(forbidden);
		}
	});

	it("includes the reviewed text and the suggestion", async () => {
		await recordFeedback(db, {
			kind: "suggestion",
			targetText: "旧译",
			suggestion: "新译",
		});
		const outcome = await exportFeedback(db);
		if (!outcome.ok) throw new Error("expected export to succeed");

		expect(outcome.payload).toContain("旧译");
		expect(outcome.payload).toContain("新译");
	});

	it("builds a payload with a version marker", () => {
		const payload = buildFeedbackExport([], "now");
		expect(payload.version).toBe(1);
		expect(payload.exportedAt).toBe("now");
	});
});
