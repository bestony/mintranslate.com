/**
 * Throttle.
 *
 * Limits a call to at most once per window. `leading` and `trailing` are
 * independent because both behaviours are genuinely wanted in different places:
 * a burst of progress updates wants `leading` only (drop the rest), while a
 * resize-like signal wants `trailing` (act once it settles).
 *
 * With `leading` only, calls inside a window are discarded rather than queued —
 * that is the intended difference from `debounce`. Discarding therefore has to
 * hold even when no timer is running, which is why the window is tracked by
 * timestamp rather than by "is a timer alive".
 */

/** Options for `throttle`. */
export interface ThrottleOptions {
	/** Run on the leading edge of a window. Default `true`. */
	readonly leading?: boolean;
	/** Run once at the end of a window that saw further calls. Default `true`. */
	readonly trailing?: boolean;
}

/** A throttled function with explicit control over a pending trailing call. */
export interface Throttled<Args extends readonly unknown[]> {
	(...args: Args): void;
	/** Drop a pending trailing call and end the current window. */
	cancel(): void;
}

/**
 * Create a throttled function.
 */
export function throttle<Args extends readonly unknown[]>(
	fn: (...args: Args) => void,
	waitMs: number,
	options: ThrottleOptions = {},
): Throttled<Args> {
	const leading = options.leading ?? true;
	const trailing = options.trailing ?? true;

	let timer: ReturnType<typeof setTimeout> | undefined;
	/** When the current window ends. `undefined` means no window is open. */
	let windowEndsAt: number | undefined;
	let pendingArgs: Args | undefined;

	function run(args: Args): void {
		fn(...args);
	}

	/** Close the current window, firing a trailing call if one is queued. */
	function closeWindow(): void {
		timer = undefined;
		windowEndsAt = undefined;

		const args = pendingArgs;
		pendingArgs = undefined;

		if (trailing && args !== undefined) run(args);
	}

	function openWindow(): void {
		windowEndsAt = Date.now() + waitMs;

		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(closeWindow, waitMs);
	}

	const throttled = ((...args: Args) => {
		const now = Date.now();
		const inWindow = windowEndsAt !== undefined && now < windowEndsAt;

		if (!inWindow) {
			if (leading) {
				run(args);
				// Open the window unconditionally: even with `trailing` off, the
				// window is what suppresses calls inside it. Without it, "leading
				// only" would fire on every call.
				openWindow();
				return;
			}

			// `leading` disabled: hold this call until the window closes. The
			// window still opens now, so the wait is bounded.
			pendingArgs = args;
			openWindow();
			return;
		}

		// Inside a window: queue for the trailing edge, or drop it. Dropping is
		// what "leading only" means, and it must happen whether or not a timer
		// is alive.
		pendingArgs = trailing ? args : undefined;
	}) as Throttled<Args>;

	throttled.cancel = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		windowEndsAt = undefined;
		pendingArgs = undefined;
	};

	return throttled;
}
