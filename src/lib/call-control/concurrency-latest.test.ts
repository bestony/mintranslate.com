import { describe, expect, it, vi } from "vitest";

import { createConcurrencyLimiter, createKeyedLimiters } from "./concurrency";
import {
	classifyAbort,
	createLatestCall,
	SupersededError,
} from "./latest-call";
import {
	createSingleFlight,
	createSingleFlightWithState,
} from "./single-flight";

/** A promise with externally controlled resolution. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("single-flight", () => {
	it("collapses concurrent calls for the same key into one", async () => {
		const flight = createSingleFlight<string, string>();
		const run = vi.fn().mockResolvedValue("result");

		const [first, second, third] = await Promise.all([
			flight("a", run),
			flight("a", run),
			flight("a", run),
		]);

		expect(run).toHaveBeenCalledTimes(1);
		expect(first).toBe("result");
		expect(second).toBe("result");
		expect(third).toBe("result");
	});

	it("starts a fresh call after the first settles", async () => {
		const flight = createSingleFlight<string, string>();
		const run = vi
			.fn()
			.mockResolvedValueOnce("one")
			.mockResolvedValueOnce("two");

		await flight("a", run);
		await flight("a", run);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("shares a failure with every waiting caller, then allows a retry", async () => {
		const flight = createSingleFlight<string, string>();
		const run = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce("ok");

		const results = await Promise.allSettled([
			flight("a", run),
			flight("a", run),
		]);
		expect(results[0].status).toBe("rejected");
		expect(results[1].status).toBe("rejected");
		expect(run).toHaveBeenCalledTimes(1);

		// The key was released, so the operation can be attempted again.
		await expect(flight("a", run)).resolves.toBe("ok");
	});

	it("does not merge or block different keys", async () => {
		const flight = createSingleFlight<string, string>();
		const slow = deferred<string>();
		const runA = vi.fn().mockReturnValue(slow.promise);
		const runB = vi.fn().mockResolvedValue("b");

		const promiseA = flight("a", runA);
		// `b` must not wait on `a`.
		const valueB = await flight("b", runB);
		expect(valueB).toBe("b");

		slow.resolve("a");
		await expect(promiseA).resolves.toBe("a");
		expect(runA).toHaveBeenCalledTimes(1);
		expect(runB).toHaveBeenCalledTimes(1);
	});

	it("releases the key once settled", async () => {
		const state = createSingleFlightWithState<string, string>();
		const slow = deferred<string>();

		const promise = state.run("a", () => slow.promise);
		expect(state.has("a")).toBe(true);
		expect(state.size()).toBe(1);

		slow.resolve("done");
		await promise;

		expect(state.has("a")).toBe(false);
		expect(state.size()).toBe(0);
	});
});

describe("latest-call — supersede and abort", () => {
	it("aborts the previous call when a newer one starts", async () => {
		const latest = createLatestCall();
		const signals: AbortSignal[] = [];
		const first = deferred<string>();

		const firstOutcome = latest.run(async (signal) => {
			signals.push(signal);
			return first.promise;
		});

		const secondOutcome = latest.run(async (signal) => {
			signals.push(signal);
			return "second";
		});

		expect(signals[0].aborted).toBe(true);
		expect(signals[1].aborted).toBe(false);

		first.resolve("first");
		// The superseded call reports superseded even though it eventually
		// produced a value, so the caller cannot write a stale result.
		await expect(firstOutcome).resolves.toEqual({ kind: "superseded" });
		await expect(secondOutcome).resolves.toEqual({
			kind: "result",
			value: "second",
		});
	});

	it("does not surface a stale result when a newer call started", async () => {
		const latest = createLatestCall();
		const slow = deferred<string>();

		const stale = latest.run(() => slow.promise);
		await latest.run(async () => "fresh");

		slow.resolve("stale-value");
		const outcome = await stale;
		expect(outcome.kind).toBe("superseded");
	});

	it("records the abort reason as superseded", async () => {
		const latest = createLatestCall();
		const slow = deferred<string>();
		const stale = latest.run(() => slow.promise);
		await latest.run(async () => "fresh");
		slow.resolve("x");
		await stale;

		expect(latest.lastAbortReason()).toBe("superseded");
	});

	it("cancel aborts as a user cancellation and discards the result", async () => {
		const latest = createLatestCall();
		const slow = deferred<string>();
		const outcome = latest.run(() => slow.promise);

		latest.cancel();
		slow.resolve("after-cancel");

		await expect(outcome).resolves.toEqual({ kind: "superseded" });
		expect(latest.lastAbortReason()).toBe("cancelled");
	});

	it("reports busy only while a call is in progress", async () => {
		const latest = createLatestCall();
		const slow = deferred<string>();

		const promise = latest.run(() => slow.promise);
		expect(latest.busy()).toBe(true);

		slow.resolve("done");
		await promise;
		expect(latest.busy()).toBe(false);
	});

	it("propagates an error when the failing call is still current", async () => {
		const latest = createLatestCall();
		await expect(
			latest.run(async () => {
				throw new Error("current failure");
			}),
		).rejects.toThrow("current failure");
	});

	it("distinguishes superseded from user-cancelled and timed-out aborts", () => {
		expect(classifyAbort({ superseded: true })).toBe("superseded");
		expect(classifyAbort({ cancelledByUser: true })).toBe("cancelled");
		expect(classifyAbort({ timedOut: true })).toBe("timeout");
		expect(classifyAbort({})).toBeUndefined();
	});

	it("exposes SupersededError as a distinct type", () => {
		const error = new SupersededError();
		expect(error.name).toBe("SupersededError");
		expect(error.reason).toBe("superseded");
	});
});

describe("concurrency limiter", () => {
	it("never exceeds the configured maximum", async () => {
		const limiter = createConcurrencyLimiter(2);
		let peak = 0;
		let running = 0;

		const task = async () => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 1));
			running -= 1;
			return "done";
		};

		await Promise.all([
			limiter.run(task),
			limiter.run(task),
			limiter.run(task),
			limiter.run(task),
		]);

		expect(peak).toBeLessThanOrEqual(2);
	});

	it("defaults to two in flight", async () => {
		const limiter = createConcurrencyLimiter();
		let peak = 0;
		let running = 0;

		const task = async () => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 1));
			running -= 1;
		};

		await Promise.all([
			limiter.run(task),
			limiter.run(task),
			limiter.run(task),
		]);
		expect(peak).toBe(2);
	});

	it("queues rather than dropping when at capacity", async () => {
		const limiter = createConcurrencyLimiter(1);
		const order: string[] = [];

		const slow = deferred<void>();
		const first = limiter.run(async () => {
			order.push("first");
			await slow.promise;
		});
		const second = limiter.run(async () => {
			order.push("second");
		});

		// The second call has not started while the first holds the only slot.
		expect(order).toEqual(["first"]);
		expect(limiter.queued()).toBe(1);

		slow.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
	});

	it("does not send a queued call that was superseded while waiting", async () => {
		const limiter = createConcurrencyLimiter(1);
		const slow = deferred<void>();
		const ranStale = vi.fn();

		const holder = limiter.run(() => slow.promise);

		// This call waits for the slot, then learns it is no longer current.
		let latest = true;
		const stale = limiter.run(ranStale, () => latest);
		latest = false;

		slow.resolve();
		await holder;

		await expect(stale).resolves.toEqual({ kind: "superseded" });
		expect(ranStale).not.toHaveBeenCalled();
	});

	it("creates an independent limiter per key", async () => {
		const limiters = createKeyedLimiters(1);
		const a = limiters.for("a");
		const b = limiters.for("b");

		expect(a).not.toBe(b);
		expect(limiters.for("a")).toBe(a);
		expect(limiters.keys().sort()).toEqual(["a", "b"]);
	});
});
