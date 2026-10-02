/**
 * Message construction in `performCall`.
 *
 * The other caller tests inject a `transport`, which means they never reach the
 * code that builds messages. These cases deliberately leave `transport` out and
 * mock the provider layer instead, so the assertions are about the message the
 * provider would actually receive.
 *
 * The most important case is the first one: the text path must still send a plain
 * string. Widening the request for images must not quietly change every existing
 * text call.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createConcurrencyLimiter } from "../call-control/concurrency";
import type { Connection } from "./model";
import { createModelCaller } from "./model-caller";

/** Captured provider calls. */
const chatMock = vi.fn();

vi.mock("@tanstack/ai", () => ({
	chat: (...args: unknown[]) => chatMock(...args),
}));

vi.mock("./adapters", () => ({
	createAdapterForConnection: async () => ({ name: "stub-adapter" }),
}));

function connection(overrides: Partial<Connection> = {}): Connection {
	return {
		id: "c1",
		name: "test",
		provider: "openai",
		endpoint: "https://api.example.com/v1",
		model: "some-model",
		capabilities: { text: true, vision: true },
		status: "ok",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** The messages handed to the provider on the most recent call. */
function lastMessages(): Array<{ role: string; content: unknown }> {
	const call = chatMock.mock.calls.at(-1)?.[0] as {
		messages: Array<{ role: string; content: unknown }>;
	};
	return call.messages;
}

beforeEach(() => {
	chatMock.mockReset();
	chatMock.mockResolvedValue("translated");
});

describe("text calls keep the original message shape", () => {
	it("sends user content as a plain string", async () => {
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "text",
			userContent: "hello",
		});

		const user = lastMessages().find((m) => m.role === "user");
		expect(typeof user?.content).toBe("string");
		expect(user?.content).toBe("hello");
	});

	it("still omits an absent system instruction", async () => {
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "text",
			userContent: "hello",
		});

		expect(lastMessages().map((m) => m.role)).toEqual(["user"]);
	});

	it("sends an empty image array as the plain string, not a part array", async () => {
		// An empty list is the same situation as no list: nothing to attach.
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "text",
			userContent: "hello",
			images: [],
		});

		expect(typeof lastMessages().find((m) => m.role === "user")?.content).toBe(
			"string",
		);
	});
});

describe("vision calls send multimodal parts", () => {
	it("puts the instruction first and the image after it", async () => {
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "vision",
			userContent: "translate the text in this image",
			images: [{ base64: "AAA=", mimeType: "image/jpeg" }],
		});

		const content = lastMessages().find((m) => m.role === "user")?.content;
		expect(Array.isArray(content)).toBe(true);
		expect(content).toEqual([
			{ type: "text", text: "translate the text in this image" },
			{
				type: "image",
				source: { type: "data", value: "AAA=", mimeType: "image/jpeg" },
			},
		]);
	});

	it("carries the mime type and base64 without a data-URL prefix", async () => {
		// A `data:` prefix here would be sent as part of the value and rejected by
		// providers that expect raw base64.
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "vision",
			userContent: "go",
			images: [{ base64: "aGVsbG8=", mimeType: "image/webp" }],
		});

		const parts = lastMessages().find((m) => m.role === "user")
			?.content as Array<{
			source?: { value?: string; mimeType?: string };
		}>;
		const image = parts.find((p) => p.source !== undefined);
		expect(image?.source?.value).toBe("aGVsbG8=");
		expect(image?.source?.mimeType).toBe("image/webp");
	});

	it("supports more than one image", async () => {
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "vision",
			userContent: "go",
			images: [
				{ base64: "AAA=", mimeType: "image/jpeg" },
				{ base64: "BBB=", mimeType: "image/png" },
			],
		});

		const parts = lastMessages().find((m) => m.role === "user")
			?.content as unknown[];
		expect(parts).toHaveLength(3);
	});

	it("refuses a vision call on a connection without vision, before the provider", async () => {
		// 1.4: the existing capability guard is what enforces this; the message must
		// stay actionable rather than merely reporting the refusal.
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		const outcome = await caller.call({
			connection: connection({ capabilities: { text: true, vision: false } }),
			apiKey: "k",
			requirement: "vision",
			userContent: "go",
			images: [{ base64: "AAA=", mimeType: "image/jpeg" }],
		});

		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused" || outcome.refusal.kind !== "capability") {
			throw new Error("expected a capability refusal");
		}
		expect(outcome.refusal.reason).toContain("多模态");
		expect(chatMock).not.toHaveBeenCalled();
	});
});

describe("dedupe key", () => {
	/** A transport that never resolves, so calls stay in flight. */
	function pendingCaller() {
		chatMock.mockImplementation(() => new Promise(() => {}));
		return createModelCaller({ limiterFor: () => createConcurrencyLimiter() });
	}

	it("merges two calls that share an explicit key", async () => {
		const caller = pendingCaller();
		const request = {
			connection: connection(),
			apiKey: "k",
			requirement: "vision" as const,
			userContent: "go",
			images: [{ base64: "AAA=", mimeType: "image/jpeg" }],
			dedupeKey: "img:digest-1",
		};

		const first = caller.call(request);
		const second = caller.call(request);
		void first;
		void second;

		// Let the limiter admit the first call before asserting.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(chatMock).toHaveBeenCalledTimes(1);
	});

	it("keeps different keys as different flights", async () => {
		const caller = pendingCaller();
		const base = {
			connection: connection(),
			apiKey: "k",
			requirement: "vision" as const,
			userContent: "go",
			images: [{ base64: "AAA=", mimeType: "image/jpeg" }],
		};

		void caller.call({ ...base, dedupeKey: "img:one" });
		void caller.call({ ...base, dedupeKey: "img:two" });

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(chatMock).toHaveBeenCalledTimes(2);
	});

	it("never puts image bytes into the flight key", async () => {
		// The key is used as a map key; holding megabytes there would be a leak.
		// Asserted over the source, because the key is internal to the caller.
		const { readFileSync } = await import("node:fs");
		const source = readFileSync("src/lib/connections/model-caller.ts", "utf8");
		expect(source).toContain("request.dedupeKey ?? request.userContent");
		expect(source).not.toMatch(/\$\{[^}]*images/);
	});
});

describe("non-streaming path", () => {
	it("requests a non-streaming response when no onChunk is given", async () => {
		// 1.5: structured JSON is only parseable once complete, so image calls rely
		// on this path returning the whole text at once.
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		const outcome = await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "vision",
			userContent: "go",
			images: [{ base64: "AAA=", mimeType: "image/jpeg" }],
		});

		expect(outcome).toEqual({ kind: "result", text: "translated" });
		const call = chatMock.mock.calls.at(-1)?.[0] as { stream?: boolean };
		expect(call.stream).toBe(false);
	});

	it("returns the whole text rather than accumulating deltas", async () => {
		chatMock.mockResolvedValue("full-json-array");
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});

		const outcome = await caller.call({
			connection: connection(),
			apiKey: "k",
			requirement: "vision",
			userContent: "go",
		});

		expect(outcome).toEqual({ kind: "result", text: "full-json-array" });
	});
});
