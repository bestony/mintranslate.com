/**
 * Debounce.
 *
 * Delays a call until activity stops. Used wherever a burst of events (typing,
 * rapid clicks) must collapse into one action.
 *
 * `cancel` and `flush` are part of the contract rather than extras: callers
 * need to retract a pending call when the reason for it disappears (a
 * connection was deleted), and need to run it immediately when the user asks
 * for it explicitly (`Cmd/Ctrl + Enter`).
 */

/** Options for `debounce`. */
export interface DebounceOptions {
	/** Injectable clock, so tests can drive time without waiting. */
	readonly now?: () => number;
	readonly setTimeoutFn?: typeof setTimeout;
	readonly clearTimeoutFn?: typeof clearTimeout;
}

/** A debounced function with explicit control over its pending call. */
export interface Debounced<Args extends readonly unknown[]> {
	(...args: Args): void;
	/** Drop a pending call. It will never run. */
	cancel(): void;
	/** Run a pending call now. No-op when nothing is pending. */
	flush(): void;
	/** Whether a call is currently waiting. */
	pending(): boolean;
}

/**
 * Create a debounced function.
 *
 * Each invocation replaces the previous one and restarts the wait, so only the
 * final call in a burst runs, using the final arguments.
 */
export function debounce<Args extends readonly unknown[]>(
	fn: (...args: Args) => void,
	waitMs: number,
	options: DebounceOptions = {},
): Debounced<Args> {
	const setTimer = options.setTimeoutFn ?? setTimeout;
	const clearTimer = options.clearTimeoutFn ?? clearTimeout;

	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastArgs: Args | undefined;

	function cancel(): void {
		if (timer !== undefined) {
			clearTimer(timer);
			timer = undefined;
		}
		lastArgs = undefined;
	}

	function flush(): void {
		if (timer === undefined) return;

		clearTimer(timer);
		timer = undefined;

		const args = lastArgs;
		lastArgs = undefined;
		if (args !== undefined) fn(...args);
	}

	const debounced = ((...args: Args) => {
		if (timer !== undefined) clearTimer(timer);
		lastArgs = args;
		timer = setTimer(() => {
			timer = undefined;
			const pendingArgs = lastArgs;
			lastArgs = undefined;
			if (pendingArgs !== undefined) fn(...pendingArgs);
		}, waitMs);
	}) as Debounced<Args>;

	debounced.cancel = cancel;
	debounced.flush = flush;
	debounced.pending = () => timer !== undefined;

	return debounced;
}
