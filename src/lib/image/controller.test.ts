/**
 * Image translation orchestration.
 *
 * The caller's transport is mocked, so these cases run the real orchestration:
 * prompt assembly, the refusal paths, the parse retry, the rate-limit budget, and
 * the degradation. The two budgets get the most attention because sharing one
 * counter is the mistake that would be invisible until production.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createConcurrencyLimiter } from "../call-control/concurrency";
import type { Connection } from "../connections/model";
import { createImageTranslator } from "./controller";

/** Provider calls, captured. */
const chatMock = vi.fn();

vi.mock("@tanstack/ai", () => ({
	chat: (...args: unknown[]) => chatMock(...args),
}));

vi.mock("../connections/adapters", () => ({
	createAdapterForConnection: async () => ({ name: "stub" }),
}));

function connection(overrides: Partial<Connection> = {}): Connection {
	return {
		id: "c1",
		name: "vision model",
		provider: "openai",
		endpoint: "https://api.example.com/v1",
		model: "vision-1",
		capabilities: { text: true, vision: true },
		status: "ok",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function request(overrides: Record<string, unknown> = {}) {
	return {
		connection: connection(),
		apiKey: "k",
		imageBase64: "AAAA",
		imageMimeType: "image/jpeg",
		imageKey: "img:digest",
		targetLanguageLabel: "中文",
		requestId: "req-1",
		...overrides,
	};
}

/** A valid structured response. */
const GOOD_RESPONSE = JSON.stringify([
	{
		source: "Hello",
		target: "你好",
		box: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
	},
]);

function translator(overrides: Record<string, unknown> = {}) {
	return createImageTranslator({
		limiterFor: () => createConcurrencyLimiter(),
		sleep: async () => {},
		...overrides,
	});
}

beforeEach(() => {
	chatMock.mockReset();
	chatMock.mockResolvedValue(GOOD_RESPONSE);
});

describe("successful translation", () => {
	it("returns parsed regions", async () => {
		const outcome = await translator().translate(request());
		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result") return;
		expect(outcome.regions).toHaveLength(1);
		expect(outcome.regions[0].target).toBe("你好");
	});

	it("sends the image alongside the prompt", async () => {
		await translator().translate(request());
		const call = chatMock.mock.calls.at(-1)?.[0] as {
			messages: Array<{ role: string; content: unknown }>;
		};
		const parts = call.messages.find((m) => m.role === "user")
			?.content as Array<{
			type: string;
		}>;
		expect(parts.some((p) => p.type === "image")).toBe(true);
		expect(parts.some((p) => p.type === "text")).toBe(true);
	});

	it("returns a valid empty result when the image has no text", async () => {
		chatMock.mockResolvedValue("[]");
		const outcome = await translator().translate(request());
		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result") return;
		expect(outcome.regions).toEqual([]);
		expect(outcome.rawText).toBeUndefined();
	});
});

describe("capability refusal", () => {
	it("refuses without calling the provider when vision is unsupported", async () => {
		const outcome = await translator().translate(
			request({
				connection: connection({ capabilities: { text: true, vision: false } }),
			}),
		);

		expect(outcome.kind).toBe("refused");
		if (outcome.kind !== "refused") return;
		expect(outcome.kindReason).toContain("多模态");
		expect(chatMock).not.toHaveBeenCalled();
	});
});

describe("parse retry and degradation", () => {
	it("retries once when the first response is unreadable", async () => {
		chatMock
			.mockResolvedValueOnce("just prose, no json")
			.mockResolvedValueOnce(GOOD_RESPONSE);

		const outcome = await translator().translate(request());

		expect(chatMock).toHaveBeenCalledTimes(2);
		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result") return;
		expect(outcome.regions).toHaveLength(1);
		expect(outcome.rawText).toBeUndefined();
	});

	it("degrades to the raw text when the retry also fails", async () => {
		chatMock.mockResolvedValue("still no json here");

		const outcome = await translator().translate(request());

		expect(chatMock).toHaveBeenCalledTimes(2);
		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result") return;
		// Reported as a result with the raw text, not as a failure: the user needs to
		// see what the model said.
		expect(outcome.rawText).toBe("still no json here");
		expect(outcome.regions).toEqual([]);
	});

	it("retries with a different dedupe key so the retry is a real call", async () => {
		// Reusing the key would make the retry join the finished flight and return the
		// same unparseable text.
		chatMock
			.mockResolvedValueOnce("prose")
			.mockResolvedValueOnce(GOOD_RESPONSE);

		await translator().translate(request());
		expect(chatMock).toHaveBeenCalledTimes(2);
	});
});

describe("rate limit budget is independent of the parse budget", () => {
	it("retries a rate limit and still parses the eventual success", async () => {
		const rateLimited = Object.assign(new Error("rate limited"), {
			status: 429,
		});
		chatMock
			.mockRejectedValueOnce(rateLimited)
			.mockResolvedValueOnce(GOOD_RESPONSE);

		const outcome = await translator().translate(request());

		expect(outcome.kind).toBe("result");
		expect(chatMock).toHaveBeenCalledTimes(2);
	});

	it("does not let a rate limit consume the parse retry", async () => {
		// Sequence: 429, then unparseable, then good. If the budget were shared the
		// parse failure after the rate limit would have no retry left.
		const rateLimited = Object.assign(new Error("rate limited"), {
			status: 429,
		});
		chatMock
			.mockRejectedValueOnce(rateLimited)
			.mockResolvedValueOnce("prose")
			.mockResolvedValueOnce(GOOD_RESPONSE);

		const outcome = await translator().translate(request());

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result") return;
		expect(outcome.regions).toHaveLength(1);
	});

	it("gives up after exhausting the rate-limit budget and reports it as a failure", async () => {
		const rateLimited = Object.assign(new Error("rate limited"), {
			status: 429,
		});
		chatMock.mockRejectedValue(rateLimited);

		const outcome = await translator().translate(request());

		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.attribution.type).toBe("rate_limit_429");
	});

	it("honours a Retry-After value when deciding the wait", async () => {
		const rateLimited = Object.assign(new Error("slow down"), {
			status: 429,
			headers: { get: (name: string) => (name === "retry-after" ? "2" : null) },
		});
		const waits: number[] = [];
		chatMock
			.mockRejectedValueOnce(rateLimited)
			.mockResolvedValueOnce(GOOD_RESPONSE);

		await translator({
			sleep: async (ms: number) => {
				waits.push(ms);
			},
			maxRateLimitRetries: 1,
		}).translate(request());

		// The endpoint's own number wins over the exponential default.
		expect(waits[0]).toBe(2000);
	});
});

describe("failure attribution", () => {
	it("attributes a non-rate-limit failure with the existing enum", async () => {
		chatMock.mockRejectedValue(
			Object.assign(new Error("nope"), { status: 500 }),
		);

		const outcome = await translator().translate(request());
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.attribution.type).toBe("server_5xx");
	});

	it("attributes a 401 without retrying", async () => {
		chatMock.mockRejectedValue(
			Object.assign(new Error("bad key"), { status: 401 }),
		);

		const outcome = await translator().translate(request());
		expect(outcome.kind).toBe("failed");
		if (outcome.kind !== "failed") return;
		expect(outcome.attribution.type).toBe("auth_401");
		expect(chatMock).toHaveBeenCalledTimes(1);
	});
});

describe("cancellation", () => {
	it("exposes a cancel that does not throw when idle", () => {
		expect(() => translator().cancel("nobody")).not.toThrow();
	});
});

describe("no memory writes", () => {
	it("does not import translation memory", async () => {
		// The spec forbids writing image-origin translations to memory. Asserted over
		// the source, because the absence of a call is exactly what is being claimed.
		const { readFileSync } = await import("node:fs");
		const source = readFileSync("src/lib/image/controller.ts", "utf8");
		expect(source).not.toMatch(/translation-memory/);
	});
});
