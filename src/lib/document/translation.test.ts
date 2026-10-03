/** @vitest-environment node */

import { describe, expect, it, vi } from "vitest";

import { createKeyedLimiters } from "../call-control/concurrency";
import type { Connection } from "../connections/model";
import { logger } from "../logger";
import type { TranslationMemoryPort } from "../translation-memory";
import type { DocumentTaskRecord, TextChunk } from "./model";
import { createTaskRecord } from "./task-store";
import { documentLimiterFor, translateDocument } from "./translation";

const connection: Connection = {
	id: "doc-connection",
	name: "test",
	provider: "custom",
	endpoint: "http://model.test/v1",
	model: "model",
	capabilities: { text: true, vision: false },
	status: "ok",
	tier: "fast",
	createdAt: 1,
	updatedAt: 1,
};

function recordWithTexts(texts: readonly string[]): DocumentTaskRecord {
	const chunks: TextChunk[] = texts.map((text, index) => ({
		id: `part:${index}:0`,
		text,
		location: { part: "word/document.xml", paragraph: index, segment: 0 },
	}));
	return createTaskRecord({
		id: "task-1",
		fileName: "report.docx",
		format: "docx",
		sourceLang: "en",
		targetLang: "zh-Hans",
		styleId: "free",
		chunks: chunks.map((chunk) => ({ chunk })),
		now: 1,
	});
}

function waitFor(predicate: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - started > 1000) {
				reject(new Error("test condition timed out"));
				return;
			}
			setTimeout(tick, 0);
		};
		tick();
	});
}

describe("document translation orchestration", () => {
	it("keeps at most two model calls in flight and writes by chunk id", async () => {
		const record = recordWithTexts(["slow", "fast", "third", "fourth"]);
		let active = 0;
		let maximum = 0;
		const transport = async (request: { userContent: string }) => {
			active += 1;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) =>
				setTimeout(resolve, request.userContent.includes("slow") ? 20 : 2),
			);
			active -= 1;
			return `译文:${request.userContent}`;
		};

		const result = await translateDocument(
			{ record, connection, apiKey: "key" },
			{ transport, glossaryMatcher: async () => [] },
		);

		expect(result.kind).toBe("succeeded");
		expect(maximum).toBe(2);
		if (result.kind === "succeeded") {
			expect(result.record.chunks.map((entry) => entry.target)).toEqual([
				"译文:slow",
				"译文:fast",
				"译文:third",
				"译文:fourth",
			]);
		}
	});

	it("matches terms per chunk and skips a memory hit", async () => {
		const record = recordWithTexts(["API token", "ordinary"]);
		const calls: string[] = [];
		const contexts: unknown[] = [];
		const debug = vi.spyOn(logger, "debug");
		const memory: TranslationMemoryPort = {
			findTranslation: async (text, context) => {
				contexts.push(context);
				return text === "API token" ? "API 令牌" : undefined;
			},
			writeTranslation: async () => [],
		};

		const result = await translateDocument(
			{ record, connection, apiKey: "key" },
			{
				memory,
				glossaryVersion: "v7",
				glossaryMatcher: async (text) =>
					text.includes("ordinary")
						? [{ source: "ordinary", target: "普通" }]
						: [],
				transport: async (request) => {
					calls.push(request.userContent);
					return "普通";
				},
			},
		);

		expect(result.kind).toBe("succeeded");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("ordinary => 普通");
		expect(calls[0]).not.toContain("API token");
		expect(result.kind === "succeeded" && result.memoryHits).toBe(1);
		expect(contexts).toEqual([
			expect.objectContaining({
				sl: "en",
				tl: "zh-Hans",
				styleId: "free",
				glossaryVersion: "v7",
				tier: "fast",
			}),
			expect.objectContaining({
				sl: "en",
				tl: "zh-Hans",
				styleId: "free",
				glossaryVersion: "v7",
				tier: "fast",
			}),
		]);
		expect(
			debug.mock.calls.some(
				([event, fields]) =>
					event === "document.chunk.memory-hit" &&
					(fields as { memoryHits?: number } | undefined)?.memoryHits === 1,
			),
		).toBe(true);
		debug.mockRestore();
	});

	it("uses Retry-After and preserves progress after an exhausted retry", async () => {
		const record = recordWithTexts(["done", "fails"]);
		let attempts = 0;
		const waits: number[] = [];
		const result = await translateDocument(
			{ record, connection, apiKey: "key" },
			{
				limiterFor: documentLimiterFor,
				maxRateLimitRetries: 1,
				sleep: async (milliseconds) => {
					waits.push(milliseconds);
				},
				glossaryMatcher: async () => [],
				transport: async (request) => {
					if (request.userContent === "done") return "完成";
					attempts += 1;
					const error = Object.assign(new Error("rate limited"), {
						status: 429,
						headers: { "retry-after": "3" },
					});
					throw error;
				},
			},
		);

		expect(result.kind).toBe("failed");
		expect(attempts).toBe(2);
		expect(waits).toEqual([3000]);
		if (result.kind === "failed") {
			expect(result.record.chunks[0]?.target).toBe("完成");
			expect(result.record.chunks[1]?.target).toBeUndefined();
			expect(result.record.failureKind).toBe("error");
		}
	});

	it("stops queued chunks after a non-retryable failure", async () => {
		const record = recordWithTexts(["fails", "queued", "also queued"]);
		const calls: string[] = [];
		const limiters = createKeyedLimiters(1);

		const result = await translateDocument(
			{ record, connection, apiKey: "key" },
			{
				limiterFor: limiters.for,
				glossaryMatcher: async () => [],
				transport: async (request) => {
					calls.push(request.userContent);
					if (request.userContent === "fails") {
						throw new Error("capability failure");
					}
					return "should not be sent";
				},
			},
		);

		expect(result.kind).toBe("failed");
		expect(calls).toEqual(["fails"]);
	});

	it("stops queued default-transport calls before releasing a failed slot", async () => {
		const record = recordWithTexts(["fails", "queued", "also queued"]);
		const limiters = createKeyedLimiters(1);
		const originalFetch = globalThis.fetch;
		const requestBodies: string[] = [];
		globalThis.fetch = (async (_input, init) => {
			requestBodies.push(typeof init?.body === "string" ? init.body : "");
			throw new Error("default transport failure");
		}) as typeof fetch;

		try {
			const result = await translateDocument(
				{
					record,
					connection: { ...connection, endpoint: "https://model.test/v1" },
					apiKey: "key",
				},
				{
					limiterFor: limiters.for,
					glossaryMatcher: async () => [],
				},
			);

			expect(result.kind).toBe("failed");
			expect(requestBodies.length).toBeGreaterThan(0);
			expect(new Set(requestBodies)).toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("resumes only unfinished chunks", async () => {
		const base = recordWithTexts(["already done", "needs work"]);
		const record: DocumentTaskRecord = {
			...base,
			state: "failed",
			failureKind: "error",
			chunks: [{ ...base.chunks[0], target: "已完成" }, base.chunks[1]],
		};
		const calls: string[] = [];

		const result = await translateDocument(
			{ record, connection, apiKey: "key" },
			{
				glossaryMatcher: async () => [],
				transport: async (request) => {
					calls.push(request.userContent);
					return "补全";
				},
			},
		);

		expect(result.kind).toBe("succeeded");
		expect(calls).toEqual(["needs work"]);
		if (result.kind === "succeeded") {
			expect(result.record.chunks.map((entry) => entry.target)).toEqual([
				"已完成",
				"补全",
			]);
		}
	});

	it("cancels in-flight calls without attributing a model error", async () => {
		const record = recordWithTexts(["long"]);
		const controller = new AbortController();
		let calls = 0;
		const resultPromise = translateDocument(
			{ record, connection, apiKey: "key", signal: controller.signal },
			{
				glossaryMatcher: async () => [],
				transport: async (_request, signal) => {
					calls += 1;
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{
								once: true,
							},
						);
					});
					return "unreachable";
				},
			},
		);
		await waitFor(() => calls === 1);
		controller.abort();
		const result = await resultPromise;

		expect(result.kind).toBe("cancelled");
		if (result.kind === "cancelled") {
			expect(result.record.failureKind).toBe("cancelled");
			expect(result.record.failureDetail).toBeUndefined();
		}
	});

	it("keeps an earlier completed chunk when a later chunk is cancelled", async () => {
		const record = recordWithTexts(["quick", "long", "middle", "pending"]);
		const controller = new AbortController();
		let calls = 0;
		const resultPromise = translateDocument(
			{ record, connection, apiKey: "key", signal: controller.signal },
			{
				glossaryMatcher: async () => [],
				transport: async (request, signal) => {
					calls += 1;
					if (request.userContent === "quick") return "快速";
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{
								once: true,
							},
						);
					});
					return "unreachable";
				},
			},
		);
		await waitFor(() => calls >= 3);
		const callsAtAbort = calls;
		controller.abort();
		const result = await resultPromise;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(result.kind).toBe("cancelled");
		expect(calls).toBe(callsAtAbort);
		if (result.kind === "cancelled") {
			expect(result.record.chunks[0]?.target).toBe("快速");
			expect(result.record.chunks[1]?.target).toBeUndefined();
			expect(result.record.chunks[2]?.target).toBeUndefined();
			expect(result.record.chunks[3]?.target).toBeUndefined();
			expect(result.record.failureKind).toBe("cancelled");
		}
	});

	it("keeps document text out of orchestration logs", async () => {
		const record = recordWithTexts(["SECRET_SOURCE"]);
		const debug = vi.spyOn(logger, "debug");
		await translateDocument(
			{ record, connection, apiKey: "key", requestId: "log-test" },
			{
				glossaryMatcher: async () => [],
				transport: async () => "SECRET_TARGET",
			},
		);
		const serialized = JSON.stringify(debug.mock.calls);
		expect(serialized).not.toContain("SECRET_SOURCE");
		expect(serialized).not.toContain("SECRET_TARGET");
		debug.mockRestore();
	});
});
