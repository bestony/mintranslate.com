import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debounce } from "./debounce";
import { throttle } from "./throttle";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("debounce", () => {
	it("runs once for a burst and uses the last arguments", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 600);

		debounced("a");
		debounced("b");
		debounced("c");
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(600);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("c");
	});

	it("does not run after cancel", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 600);

		debounced("a");
		debounced.cancel();

		vi.advanceTimersByTime(10_000);
		expect(fn).not.toHaveBeenCalled();
	});

	it("cancel clears the pending state", () => {
		const debounced = debounce(vi.fn(), 600);
		debounced("a");
		expect(debounced.pending()).toBe(true);
		debounced.cancel();
		expect(debounced.pending()).toBe(false);
	});

	it("flush runs immediately and does not run again later", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 600);

		debounced("a");
		debounced.flush();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("a");

		vi.advanceTimersByTime(10_000);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("flush with nothing pending is safe", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 600);

		expect(() => debounced.flush()).not.toThrow();
		expect(fn).not.toHaveBeenCalled();
	});

	it("flush after cancel does nothing", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 600);
		debounced("a");
		debounced.cancel();
		debounced.flush();
		expect(fn).not.toHaveBeenCalled();
	});

	it("restarts the wait on each call so a steady stream never fires", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 600);

		for (let index = 0; index < 10; index += 1) {
			debounced(index);
			vi.advanceTimersByTime(300);
		}
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(600);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("can run again after settling", () => {
		const fn = vi.fn();
		const debounced = debounce(fn, 600);
		debounced("a");
		vi.advanceTimersByTime(600);
		debounced("b");
		vi.advanceTimersByTime(600);
		expect(fn).toHaveBeenNthCalledWith(1, "a");
		expect(fn).toHaveBeenNthCalledWith(2, "b");
	});
});

describe("throttle — leading only", () => {
	it("runs on the leading edge and drops calls inside the window", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 1000, { leading: true, trailing: false });

		throttled(1);
		expect(fn).toHaveBeenCalledTimes(1);

		throttled(2);
		throttled(3);
		vi.advanceTimersByTime(1000);

		// Dropped, not queued: still exactly one call.
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith(1);
	});

	it("allows a call once the window has passed", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 1000, { leading: true, trailing: false });

		throttled(1);
		vi.advanceTimersByTime(1000);
		throttled(2);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

describe("throttle — trailing only", () => {
	it("does not run on the leading edge", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 1000, { leading: false, trailing: true });

		throttled(1);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith(1);
	});

	it("uses the most recent arguments at the trailing edge", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 1000, { leading: false, trailing: true });

		throttled("first");
		vi.advanceTimersByTime(400);
		throttled("second");

		vi.advanceTimersByTime(600);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("second");
	});
});

describe("throttle — leading and trailing", () => {
	it("runs once at each edge", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 1000);

		throttled("a");
		expect(fn).toHaveBeenCalledTimes(1);

		throttled("b");
		vi.advanceTimersByTime(1000);

		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenNthCalledWith(2, "b");
	});

	it("does not fire a trailing call when none arrived in the window", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 1000);

		throttled("a");
		vi.advanceTimersByTime(5000);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("cancel drops a pending trailing call", () => {
		const fn = vi.fn();
		const throttled = throttle(fn, 1000);

		throttled("a");
		throttled("b");
		throttled.cancel();

		vi.advanceTimersByTime(5000);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledWith("a");
	});
});
