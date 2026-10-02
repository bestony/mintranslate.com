import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type ControllerCallbacks,
	createTranslationController,
	DEBOUNCE_MS,
	MANUAL_THROTTLE_MS,
	type TranslationInput,
	type TranslationRunner,
} from "./controller";

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

function input(overrides: Partial<TranslationInput> = {}): TranslationInput {
	return {
		text: "hello",
		sourceLang: "auto",
		targetLang: "zh-Hans",
		connectionId: "conn-1",
		composing: false,
		...overrides,
	};
}

/** Build a controller with recording callbacks and a stub runner. */
function harness(runner?: TranslationRunner) {
	const events: string[] = [];
	const callbacks: ControllerCallbacks = {
		onStart: (id) => events.push(`start:${id}`),
		onChunk: (id, delta) => events.push(`chunk:${id}:${delta}`),
		onSuccess: (id, text) => events.push(`success:${id}:${text}`),
		onFailure: (id) => events.push(`failure:${id}`),
		onSuperseded: (id) => events.push(`superseded:${id}`),
	};

	const run = vi.fn(runner ?? (async () => ({ text: "译文" })));

	const controller = createTranslationController({ run, callbacks });
	return { controller, run, events };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("auto trigger", () => {
	it("translates once after the debounce window", async () => {
		const { controller, run } = harness();

		controller.update(input());
		expect(run).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("coalesces rapid typing into one request", async () => {
		const { controller, run } = harness();

		controller.update(input({ text: "h" }));
		await vi.advanceTimersByTimeAsync(200);
		controller.update(input({ text: "he" }));
		await vi.advanceTimersByTimeAsync(200);
		controller.update(input({ text: "hel" }));
		expect(run).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0].input.text).toBe("hel");
	});

	it("does not translate a steady stream of keystrokes", async () => {
		const { controller, run } = harness();

		for (let index = 0; index < 10; index += 1) {
			controller.update(input({ text: `x${index}` }));
			await vi.advanceTimersByTimeAsync(300);
		}
		expect(run).not.toHaveBeenCalled();
	});

	it("uses the decided 600ms window", () => {
		expect(DEBOUNCE_MS).toBe(600);
	});
});

describe("IME composition", () => {
	it("does not translate while composing", async () => {
		const { controller, run } = harness();

		controller.compositionStart();
		controller.update(input({ text: "ni", composing: true }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);

		expect(run).not.toHaveBeenCalled();
	});

	it("restarts the debounce after composition ends", async () => {
		const { controller, run } = harness();

		controller.compositionStart();
		controller.update(input({ text: "你", composing: true }));
		controller.compositionEnd();

		// Not immediate: the user may still be typing.
		expect(run).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending auto-trigger when composition begins", async () => {
		const { controller, run } = harness();

		controller.update(input());
		controller.compositionStart();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

		expect(run).not.toHaveBeenCalled();
	});
});

describe("suppression", () => {
	it("does not re-request when nothing changed", async () => {
		const { controller, run } = harness();
		const same = input();

		controller.update(same);
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(run).toHaveBeenCalledTimes(1);

		// Same text, direction and connection: a second request would be wasted.
		controller.update({ ...same });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("re-requests when the text changes", async () => {
		const { controller, run } = harness();

		controller.update(input({ text: "one" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		controller.update(input({ text: "two" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("re-requests when the language direction changes", async () => {
		const { controller, run } = harness();

		controller.update(input({ targetLang: "zh-Hans" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		controller.update(input({ targetLang: "ja" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("re-requests when the active connection changes", async () => {
		const { controller, run } = harness();

		controller.update(input({ connectionId: "a" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		controller.update(input({ connectionId: "b" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("suppresses whitespace-only input", async () => {
		const { controller, run } = harness();

		controller.update(input({ text: "   \n\t " }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

		expect(run).not.toHaveBeenCalled();
	});

	it("suppresses when no connection is configured", async () => {
		const { controller, run } = harness();

		controller.update(input({ connectionId: undefined }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

		expect(run).not.toHaveBeenCalled();
	});

	it("reports the suppression reason to the caller", async () => {
		const { controller } = harness();

		controller.update(input({ text: "   " }));
		expect(controller.trigger()).toEqual({
			kind: "suppressed",
			reason: "empty-input",
		});

		// Past the manual-trigger guard, so this call is evaluated on its merits
		// rather than being throttled.
		await vi.advanceTimersByTimeAsync(MANUAL_THROTTLE_MS);
		controller.update(input({ connectionId: undefined }));
		expect(controller.trigger()).toEqual({
			kind: "suppressed",
			reason: "no-connection",
		});
	});
});

describe("manual trigger", () => {
	it("runs immediately without waiting for the debounce", async () => {
		const { controller, run } = harness();

		controller.update(input());
		const outcome = controller.trigger();

		expect(outcome.kind).toBe("started");
		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("drops repeat clicks inside the throttle window", async () => {
		const { controller, run } = harness();

		controller.update(input({ text: "a" }));
		controller.trigger();

		// Three more clicks inside the window must not queue extra requests.
		controller.update(input({ text: "b" }));
		controller.trigger();
		controller.update(input({ text: "c" }));
		controller.trigger();

		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reports throttled when a click is swallowed", async () => {
		const { controller } = harness();

		controller.update(input());
		controller.trigger();
		const second = controller.trigger();

		expect(second).toEqual({ kind: "suppressed", reason: "throttled" });
	});

	it("allows a new manual trigger after the window closes", async () => {
		const { controller, run } = harness();

		controller.update(input({ text: "a" }));
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(MANUAL_THROTTLE_MS);

		controller.update(input({ text: "b" }));
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("uses the decided 400ms window", () => {
		expect(MANUAL_THROTTLE_MS).toBe(400);
	});
});

describe("supersede and result ownership", () => {
	it("aborts the previous request when a new one starts", async () => {
		const first = deferred<{ text: string }>();
		const signals: AbortSignal[] = [];
		const run = vi.fn(async (options: { signal: AbortSignal }) => {
			signals.push(options.signal);
			if (signals.length === 1) return first.promise;
			return { text: "second" };
		});
		const { controller } = harness(run as unknown as TranslationRunner);

		controller.update(input({ text: "one" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		// Continuing to type is what supersedes an in-flight request.
		controller.update(input({ text: "two" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(signals[0].aborted).toBe(true);
		first.resolve({ text: "first" });
		await vi.advanceTimersByTimeAsync(0);
	});

	it("does not write back the result of a superseded request", async () => {
		const stale = deferred<{ text: string }>();
		let callCount = 0;
		const run = vi.fn(async () => {
			callCount += 1;
			if (callCount === 1) return stale.promise;
			return { text: "fresh" };
		});
		const { controller, events } = harness(run as unknown as TranslationRunner);

		controller.update(input({ text: "one" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		controller.update(input({ text: "two" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		// The abandoned request finally produces a result: it must be discarded.
		stale.resolve({ text: "stale" });
		await vi.advanceTimersByTimeAsync(0);

		const successes = events.filter((event) => event.startsWith("success:"));
		expect(successes).toHaveLength(1);
		expect(successes[0]).toContain("fresh");
		expect(events.some((event) => event.startsWith("superseded:"))).toBe(true);
	});

	it("abandons an in-flight request when the input is cleared", async () => {
		const pending = deferred<{ text: string }>();
		const signals: AbortSignal[] = [];
		const run = vi.fn(async (options: { signal: AbortSignal }) => {
			signals.push(options.signal);
			return pending.promise;
		});
		const { controller, events } = harness(run as unknown as TranslationRunner);

		controller.update(input());
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);

		controller.update(input({ text: "" }));

		expect(signals[0].aborted).toBe(true);
		pending.resolve({ text: "late" });
		await vi.advanceTimersByTimeAsync(0);

		expect(events.filter((e) => e.startsWith("success:"))).toHaveLength(0);
	});

	it("aborts the stream when the input changes mid-stream", async () => {
		const signals: AbortSignal[] = [];
		let releaseStream: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});

		const run = vi.fn(
			async (options: {
				signal: AbortSignal;
				onChunk: (d: string) => void;
			}) => {
				signals.push(options.signal);
				options.onChunk("部分");
				await gate;
				return { text: "部分译文" };
			},
		);
		const { controller, events } = harness(run as unknown as TranslationRunner);

		controller.update(input({ text: "one" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		expect(events.some((e) => e.startsWith("chunk:"))).toBe(true);

		const abandonedId = events.find((e) => e.startsWith("start:"))?.slice(6);
		expect(abandonedId).toBeDefined();

		// User keeps typing while the stream is arriving.
		controller.update(input({ text: "one more" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(signals[0].aborted).toBe(true);

		releaseStream?.();
		await vi.advanceTimersByTimeAsync(0);

		// The abandoned request must never produce a final result. The second
		// request may legitimately succeed, so the assertion is about which id
		// succeeded rather than about the absence of any success.
		const abandonedSuccess = events.filter((e) =>
			e.startsWith(`success:${abandonedId}:`),
		);
		expect(abandonedSuccess).toHaveLength(0);
	});
});

describe("retry", () => {
	it("is allowed even when nothing changed", async () => {
		const run = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ text: "ok" });
		const { controller, events } = harness(run as unknown as TranslationRunner);

		controller.update(input());
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(events.some((e) => e.startsWith("failure:"))).toBe(true);

		// The user explicitly asked to try again on the same input.
		const outcome = controller.retry();
		expect(outcome.kind).toBe("started");
	});

	it("surfaces failures to the callback", async () => {
		const run = vi.fn().mockRejectedValue(new Error("nope"));
		const { controller, events } = harness(run as unknown as TranslationRunner);

		controller.update(input());
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);

		expect(events.some((e) => e.startsWith("failure:"))).toBe(true);
	});
});

describe("request correlation", () => {
	it("gives each request a distinct id", async () => {
		const { controller, events } = harness();

		controller.update(input({ text: "one" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		controller.update(input({ text: "two" }));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		const ids = events
			.filter((e) => e.startsWith("start:"))
			.map((e) => e.slice(6));
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("passes the id to the runner so logs can be correlated", async () => {
		const { controller, run } = harness();

		controller.update(input());
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);

		const passed = run.mock.calls[0][0] as { requestId: string };
		expect(passed.requestId).toHaveLength(8);
	});

	it("reports success with the request id", async () => {
		const { controller, events } = harness();

		controller.update(input());
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);

		expect(events.some((e) => e.startsWith("success:"))).toBe(true);
	});
});

describe("cancel", () => {
	it("drops a pending auto-trigger", async () => {
		const { controller, run } = harness();

		controller.update(input());
		controller.cancel();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);

		expect(run).not.toHaveBeenCalled();
	});

	it("allows the same input to be requested again after cancel", async () => {
		const { controller, run } = harness();
		const same = input();

		controller.update(same);
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
		controller.cancel();

		controller.update({ ...same });
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

		expect(run).toHaveBeenCalledTimes(2);
	});
});
