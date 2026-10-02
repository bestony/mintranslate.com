import { describe, expect, it, vi } from "vitest";

import { createConcurrencyLimiter } from "../call-control/concurrency";
import type { Connection } from "./model";
import { createModelCaller } from "./model-caller";

/**
 * These tests exercise the refusal paths and the concurrency cap, which are the
 * parts that must hold before any network work happens. `performCall` is not
 * reached, so no provider package is loaded and no request is made.
 */

function connection(
	overrides: Partial<Connection> & Pick<Connection, "id">,
): Connection {
	return {
		name: overrides.id,
		provider: "openai",
		endpoint: "https://api.example.com/v1",
		model: "some-model",
		capabilities: { text: true, vision: false },
		status: "ok",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("model caller — capability refusal happens before any request", () => {
	it("refuses a vision call on a text-only connection", async () => {
		const limiter = createConcurrencyLimiter();
		const runSpy = vi.spyOn(limiter, "run");
		const caller = createModelCaller({ limiterFor: () => limiter });

		const outcome = await caller.call({
			connection: connection({
				id: "a",
				capabilities: { text: true, vision: false },
			}),
			apiKey: "k",
			requirement: "vision",
			userContent: "describe this",
		});

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused" && outcome.refusal.kind === "capability") {
			expect(outcome.refusal.reason).toContain("多模态");
		} else {
			throw new Error("expected a capability refusal");
		}

		// Nothing was even queued for execution.
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("allows a text call on a text-only connection to proceed past the guard", async () => {
		const limiter = createConcurrencyLimiter();
		const transport = vi.fn().mockResolvedValue("translated");
		const caller = createModelCaller({ limiterFor: () => limiter, transport });

		const outcome = await caller.call({
			connection: connection({ id: "a" }),
			apiKey: "k",
			requirement: "text",
			userContent: "hello",
		});

		expect(outcome).toEqual({ kind: "result", text: "translated" });
		expect(transport).toHaveBeenCalledTimes(1);
	});
});

describe("model caller — concurrency cap", () => {
	it("uses the limiter for the connection it was asked about", async () => {
		const limiters = new Map<
			string,
			ReturnType<typeof createConcurrencyLimiter>
		>();
		const requested: string[] = [];

		const caller = createModelCaller({
			limiterFor: (id) => {
				requested.push(id);
				let limiter = limiters.get(id);
				if (!limiter) {
					limiter = createConcurrencyLimiter(2);
					limiters.set(id, limiter);
				}
				return limiter;
			},
			transport: vi.fn().mockResolvedValue("ok"),
		});

		await caller.call({
			connection: connection({ id: "conn-1" }),
			apiKey: "k",
			requirement: "text",
			userContent: "x",
		});

		expect(requested).toContain("conn-1");
	});
});

describe("model caller — single flight and supersede", () => {
	it("merges identical concurrent calls for the same connection", async () => {
		const transport = vi.fn().mockResolvedValue("shared");
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(2),
			transport,
		});
		const request = {
			connection: connection({ id: "a" }),
			apiKey: "k",
			requirement: "text" as const,
			userContent: "same text",
		};

		const [first, second] = await Promise.all([
			caller.call(request),
			caller.call(request),
		]);

		expect(first).toEqual({ kind: "result", text: "shared" });
		expect(second).toEqual({ kind: "result", text: "shared" });
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it("does not merge calls with different content", async () => {
		const transport = vi.fn().mockResolvedValue("x");
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(2),
			transport,
		});

		await Promise.all([
			caller.call({
				connection: connection({ id: "a" }),
				apiKey: "k",
				requirement: "text",
				userContent: "one",
			}),
			caller.call({
				connection: connection({ id: "a" }),
				apiKey: "k",
				requirement: "text",
				userContent: "two",
			}),
		]);

		expect(transport).toHaveBeenCalledTimes(2);
	});

	it("reports a superseded call rather than returning its stale text", async () => {
		let releaseFirst: (() => void) | undefined;
		const transport = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						releaseFirst = () => resolve("stale");
					}),
			)
			.mockResolvedValueOnce("fresh");

		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(4),
			transport,
		});

		const stale = caller.call({
			connection: connection({ id: "a" }),
			apiKey: "k",
			requirement: "text",
			userContent: "first",
		});
		const fresh = await caller.call({
			connection: connection({ id: "a" }),
			apiKey: "k",
			requirement: "text",
			userContent: "second",
		});

		expect(fresh).toEqual({ kind: "result", text: "fresh" });

		releaseFirst?.();
		await expect(stale).resolves.toEqual({
			kind: "refused",
			refusal: { kind: "superseded" },
		});
	});
});

describe("model caller — busy and cancel", () => {
	it("reports not busy when idle", () => {
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});
		expect(caller.busy("nobody")).toBe(false);
	});

	it("cancel on an idle connection is safe", () => {
		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
		});
		expect(() => caller.cancel("nobody")).not.toThrow();
	});
});
