import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSearchControl, SEARCH_DEBOUNCE_MS } from "./search-control";

/** Externally controllable promise. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function harness<T>(
	runner?: (input: string, signal: AbortSignal) => Promise<T>,
) {
	const results: T[] = [];
	const pendingStates: boolean[] = [];
	let cleared = 0;

	const run = vi.fn(
		runner ?? (async (input: string) => `result:${input}` as unknown as T),
	);

	const control = createSearchControl<T>({
		run,
		callbacks: {
			onResult: (result) => results.push(result),
			onPendingChange: (pending) => pendingStates.push(pending),
			onCleared: () => {
				cleared += 1;
			},
		},
	});

	return { control, run, results, pendingStates, clearedCount: () => cleared };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("debounce", () => {
	it("runs once after the window", async () => {
		const { control, run } = harness();

		control.update("a");
		expect(run).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("collapses rapid typing into a single search", async () => {
		const { control, run } = harness();

		control.update("n");
		await vi.advanceTimersByTimeAsync(100);
		control.update("ne");
		await vi.advanceTimersByTimeAsync(100);
		control.update("nee");
		expect(run).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0]).toBe("nee");
	});

	it("uses a 300ms window", () => {
		expect(SEARCH_DEBOUNCE_MS).toBe(300);
	});

	it("does not fire for a steady stream of keystrokes", async () => {
		const { control, run } = harness();

		for (let index = 0; index < 8; index += 1) {
			control.update(`term${index}`);
			await vi.advanceTimersByTimeAsync(150);
		}
		expect(run).not.toHaveBeenCalled();
	});

	it("reports pending while a search is running", async () => {
		const { control, pendingStates } = harness();

		control.update("a");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		expect(pendingStates).toContain(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(pendingStates[pendingStates.length - 1]).toBe(false);
	});
});

describe("latest wins", () => {
	it("discards a slow earlier search when a later one finishes first", async () => {
		const slow = deferred<string>();
		const calls: string[] = [];

		const { control, results } = harness(async (input: string) => {
			calls.push(input);
			if (input === "first") return slow.promise;
			return `fast:${input}`;
		});

		control.update("first");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

		control.update("second");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		await vi.advanceTimersByTimeAsync(0);

		// The newer result is shown.
		expect(results).toContain("fast:second");

		// The older search finally resolves; it must not overwrite the newer answer.
		slow.resolve("slow:first");
		await vi.advanceTimersByTimeAsync(0);

		expect(results).not.toContain("slow:first");
		expect(results[results.length - 1]).toBe("fast:second");
	});

	it("aborts the superseded search through its signal", async () => {
		const signals: AbortSignal[] = [];
		const slow = deferred<string>();

		const { control } = harness(async (input: string, signal: AbortSignal) => {
			signals.push(signal);
			if (input === "first") return slow.promise;
			return "second";
		});

		control.update("first");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

		control.update("second");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

		expect(signals[0].aborted).toBe(true);
		slow.resolve("slow");
		await vi.advanceTimersByTimeAsync(0);
	});

	it("delivers the result of the only search", async () => {
		const { control, results } = harness();

		control.update("only");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
		await vi.advanceTimersByTimeAsync(0);

		expect(results).toEqual(["result:only"]);
	});
});

describe("clearing and cancelling", () => {
	it("clears results and cancels a pending search when the input empties", async () => {
		const { control, run, results, clearedCount } = harness();

		control.update("term");
		control.update("");

		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

		expect(run).not.toHaveBeenCalled();
		expect(results).toEqual([]);
		expect(clearedCount()).toBe(1);
	});

	it("invalidates an in-flight search when the input empties", async () => {
		const slow = deferred<string>();
		const { control, results, clearedCount } = harness(
			async () => slow.promise,
		);

		control.update("term");
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

		control.update("");
		expect(clearedCount()).toBe(1);

		slow.resolve("late");
		await vi.advanceTimersByTimeAsync(0);

		// A late result must not repopulate a query the user cleared.
		expect(results).toEqual([]);
	});

	it("cancel drops a pending search without clearing", async () => {
		const { control, run, clearedCount } = harness();

		control.update("term");
		control.cancel();
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

		expect(run).not.toHaveBeenCalled();
		expect(clearedCount()).toBe(0);
	});
});

describe("runNow", () => {
	it("runs immediately without waiting", async () => {
		const { control, run } = harness();

		control.update("term");
		control.runNow();

		await vi.advanceTimersByTimeAsync(0);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("does not run again when the window elapses", async () => {
		const { control, run } = harness();

		control.update("term");
		control.runNow();
		await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

		expect(run).toHaveBeenCalledTimes(1);
	});

	it("is safe with nothing pending", () => {
		const { control, run } = harness();
		expect(() => control.runNow()).not.toThrow();
		expect(run).not.toHaveBeenCalled();
	});
});
