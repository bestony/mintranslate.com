/**
 * Task state machine, resume rules and persistence.
 *
 * The decisions worth testing are the ones that would silently produce a wrong
 * result rather than an error: re-translating finished work, reusing results that
 * belong to a different language or style, or keeping a 20MB file after the task
 * ended.
 *
 * @vitest-environment node
 */

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import type { DocumentTaskRecord, TranslatedChunk } from "./model";
import {
	applyChunkResult,
	beginProcessing,
	canTransition,
	needsSource,
	pendingChunks,
	progressOf,
	readyToSucceed,
	resetResultsForContext,
	resultsAreReusable,
	transition,
	wasCancelled,
} from "./task";
import { createTaskRecord, openDocumentTaskStore } from "./task-store";

/** Chunks for a task, optionally with some already translated. */
function chunks(done: number, total = 3): TranslatedChunk[] {
	return Array.from({ length: total }, (_, index) => ({
		chunk: {
			id: `p:${index}:0`,
			text: `source ${index}`,
			location: { part: "p", paragraph: index, segment: 0 },
		},
		...(index < done && { target: `target ${index}` }),
	}));
}

function record(
	overrides: Partial<DocumentTaskRecord> = {},
): DocumentTaskRecord {
	return {
		...createTaskRecord({
			id: "t1",
			fileName: "report.docx",
			format: "docx",
			sourceLang: "en",
			targetLang: "zh-Hans",
			styleId: "literal",
			chunks: chunks(0),
			now: 1000,
		}),
		...overrides,
	};
}

describe("transitions", () => {
	it("starts queued work and resumes failed work", () => {
		const queued = beginProcessing(record(), 2000);
		expect(queued.ok).toBe(true);
		if (queued.ok) expect(queued.record.state).toBe("processing");

		const failed = beginProcessing(
			record({ state: "failed", failureKind: "cancelled" }),
			3000,
		);
		expect(failed.ok).toBe(true);
		if (failed.ok) {
			expect(failed.record.state).toBe("processing");
			expect(failed.record.failureKind).toBeUndefined();
		}
	});

	it("allows the documented paths", () => {
		expect(canTransition("queued", "processing")).toBe(true);
		expect(canTransition("processing", "succeeded")).toBe(true);
		expect(canTransition("processing", "failed")).toBe(true);
		// Cancelling before the work starts is also a failure outcome.
		expect(canTransition("queued", "failed")).toBe(true);
	});

	it("refuses to leave a terminal state", () => {
		expect(canTransition("succeeded", "processing")).toBe(false);
		expect(canTransition("failed", "processing")).toBe(false);
		expect(canTransition("succeeded", "failed")).toBe(false);
	});

	it("refuses the move and says why instead of applying it", () => {
		const done = record({ state: "succeeded" });
		const result = transition(done, "processing", { now: 2000 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("终态");
	});

	it("applies a permitted move and stamps the time", () => {
		const result = transition(record(), "processing", { now: 2000 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.state).toBe("processing");
		expect(result.record.updatedAt).toBe(2000);
	});

	it("records a cancellation differently from an error", () => {
		const cancelled = transition(record({ state: "processing" }), "failed", {
			failureKind: "cancelled",
			now: 2000,
		});
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) return;
		expect(wasCancelled(cancelled.record)).toBe(true);

		const errored = transition(record({ state: "processing" }), "failed", {
			detail: "boom",
			now: 2000,
		});
		if (!errored.ok) return;
		expect(wasCancelled(errored.record)).toBe(false);
		expect(errored.record.failureDetail).toBe("boom");
	});
});

describe("resume", () => {
	it("only lists unfinished chunks", () => {
		const half = record({ chunks: chunks(2) });
		expect(pendingChunks(half).map((entry) => entry.chunk.id)).toEqual([
			"p:2:0",
		]);
	});

	it("lists nothing when everything is done", () => {
		expect(pendingChunks(record({ chunks: chunks(3) }))).toEqual([]);
	});

	it("knows when a task can succeed", () => {
		expect(readyToSucceed(record({ chunks: chunks(2) }))).toBe(false);
		expect(readyToSucceed(record({ chunks: chunks(3) }))).toBe(true);
	});

	it("reports progress including memory hits", () => {
		const withMemory = record({
			chunks: [
				{ chunk: chunks(1)[0].chunk, target: "t0", fromMemory: true },
				{ chunk: chunks(1, 2)[1].chunk, target: undefined },
			],
		});
		expect(progressOf(withMemory)).toEqual({
			completed: 1,
			total: 2,
			fromMemory: 1,
		});
	});
});

describe("context changes invalidate stored results", () => {
	const base = record();

	it("accepts the same context", () => {
		expect(
			resultsAreReusable(base, {
				sourceLang: "en",
				targetLang: "zh-Hans",
				styleId: "literal",
			}),
		).toBe(true);
	});

	it("rejects a different target language", () => {
		// Reusing these would deliver a mix of two translations.
		expect(
			resultsAreReusable(base, {
				sourceLang: "en",
				targetLang: "ja",
				styleId: "literal",
			}),
		).toBe(false);
	});

	it("rejects a different style", () => {
		expect(
			resultsAreReusable(base, {
				sourceLang: "en",
				targetLang: "zh-Hans",
				styleId: "free",
			}),
		).toBe(false);
	});

	it("rejects a different source language", () => {
		expect(
			resultsAreReusable(base, {
				sourceLang: "fr",
				targetLang: "zh-Hans",
				styleId: "literal",
			}),
		).toBe(false);
	});

	it("clears old results and queues a changed context", () => {
		const changed = resetResultsForContext(
			record({
				state: "failed",
				failureKind: "error",
				failureDetail: "temporary failure",
				chunks: chunks(2),
			}),
			{
				sourceLang: "en",
				targetLang: "ja",
				styleId: "literal",
			},
			3000,
		);
		expect(changed.state).toBe("queued");
		expect(changed.targetLang).toBe("ja");
		expect(changed.updatedAt).toBe(3000);
		expect(changed.failureKind).toBeUndefined();
		expect(changed.chunks.every((entry) => entry.target === undefined)).toBe(
			true,
		);
	});
});

describe("chunk results", () => {
	it("writes a result and marks its origin", () => {
		const updated = applyChunkResult(record(), "p:1:0", "译文", {
			fromMemory: true,
			now: 5000,
		});
		const entry = updated.chunks.find((c) => c.chunk.id === "p:1:0");
		expect(entry?.target).toBe("译文");
		expect(entry?.fromMemory).toBe(true);
		expect(updated.updatedAt).toBe(5000);
	});

	it("leaves other chunks alone", () => {
		const updated = applyChunkResult(record(), "p:1:0", "x", {
			fromMemory: false,
			now: 1,
		});
		expect(updated.chunks[0].target).toBeUndefined();
	});
});

describe("source lifetime", () => {
	it("keeps the source while work is outstanding", () => {
		expect(
			needsSource(record({ state: "processing" }), { rebuilt: false }),
		).toBe(true);
		expect(needsSource(record({ state: "queued" }), { rebuilt: false })).toBe(
			true,
		);
	});

	it("keeps the source until the document is rebuilt", () => {
		expect(
			needsSource(record({ state: "succeeded" }), { rebuilt: false }),
		).toBe(true);
	});

	it("drops the source once rebuilt", () => {
		// Holding up to 20MB for a finished task serves nothing.
		expect(needsSource(record({ state: "succeeded" }), { rebuilt: true })).toBe(
			false,
		);
		expect(needsSource(record({ state: "failed" }), { rebuilt: true })).toBe(
			false,
		);
	});
});

describe("persistence", () => {
	it("saves and loads a task", async () => {
		const store = await openDocumentTaskStore();
		expect(store).toBeDefined();
		if (!store) return;

		const task = record({ id: "round-trip" });
		await store.save(task);
		const loaded = await store.load("round-trip");
		expect(loaded?.fileName).toBe("report.docx");
		expect(loaded?.chunks).toHaveLength(3);
		await store.remove("round-trip");
	});

	it("lists most recently updated first", async () => {
		const store = await openDocumentTaskStore();
		if (!store) return;

		await store.save(record({ id: "old", updatedAt: 1000 }));
		await store.save(record({ id: "new", updatedAt: 9000 }));
		const list = await store.list();
		expect(list[0].id).toBe("new");
		await store.remove("old");
		await store.remove("new");
	});

	it("stores and retrieves the source file", async () => {
		const store = await openDocumentTaskStore();
		if (!store) return;

		const bytes = new Uint8Array([1, 2, 3, 4]);
		await store.saveSource("s1", bytes);
		const loaded = await store.loadSource("s1");
		expect(loaded && Array.from(loaded)).toEqual([1, 2, 3, 4]);
		await store.dropSource("s1");
		expect(await store.loadSource("s1")).toBeUndefined();
	});

	it("removing a task also removes its source", async () => {
		// A file left behind would never be cleaned up by anything else.
		const store = await openDocumentTaskStore();
		if (!store) return;

		await store.save(record({ id: "with-source" }));
		await store.saveSource("with-source", new Uint8Array([9]));
		await store.remove("with-source");
		expect(await store.load("with-source")).toBeUndefined();
		expect(await store.loadSource("with-source")).toBeUndefined();
	});

	it("drops sources of terminal tasks but keeps the active one", async () => {
		const store = await openDocumentTaskStore();
		if (!store) return;

		await store.save(record({ id: "done", state: "succeeded" }));
		await store.saveSource("done", new Uint8Array([1]));
		await store.save(record({ id: "active", state: "processing" }));
		await store.saveSource("active", new Uint8Array([2]));

		await store.dropStaleSources("active");

		expect(await store.loadSource("done")).toBeUndefined();
		expect(await store.loadSource("active")).toBeDefined();

		await store.remove("done");
		await store.remove("active");
	});
});
