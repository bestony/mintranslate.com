/**
 * Latest-wins cancellation.
 *
 * When a newer call replaces an older one, the older request must actually be
 * aborted — not merely ignored. Aborting matters because the request may still
 * be streaming tokens that cost money; ignoring the result would pay for work
 * nobody wants.
 *
 * The second half of the contract is that a late result from an aborted call
 * must never be written to shared state. `LatestCall.run` enforces that by only
 * resolving for the call that is still current.
 */

/** Reason a call was aborted, so callers can attribute it distinctly. */
export const ABORT_REASONS = ["superseded", "cancelled", "timeout"] as const;

export type AbortReason = (typeof ABORT_REASONS)[number];

/** Signals a superseded call so it is distinguishable from a user cancel. */
export class SupersededError extends Error {
	readonly reason: AbortReason = "superseded";

	constructor() {
		super("被更新的调用取代");
		this.name = "SupersededError";
	}
}

/** The outcome of a superseded call. */
export type LatestOutcome<T> =
	| { readonly kind: "result"; readonly value: T }
	| { readonly kind: "superseded" };

/** A single-slot call controller. */
export interface LatestCall {
	/**
	 * Run `task` as the newest call, aborting any call already in progress.
	 *
	 * Resolves with `superseded` when a newer call began before this one
	 * finished, so the caller can avoid writing a stale result.
	 */
	run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<LatestOutcome<T>>;
	/** Abort the in-progress call, if any, as a user cancellation. */
	cancel(): void;
	/** Whether a call is in progress. */
	busy(): boolean;
	/** Abort reason for the call that was most recently superseded. */
	lastAbortReason(): AbortReason | undefined;
}

/**
 * Create a latest-wins controller.
 *
 * Only one call may be in progress. Starting a new one aborts the previous.
 */
export function createLatestCall(): LatestCall {
	let controller: AbortController | undefined;
	let lastReason: AbortReason | undefined;
	/** Identifies the current call, so a late result can be recognised as stale. */
	let currentToken = 0;

	function abortCurrent(reason: AbortReason): void {
		if (controller) {
			lastReason = reason;
			controller.abort();
			controller = undefined;
		}
	}

	return {
		async run<T>(
			task: (signal: AbortSignal) => Promise<T>,
		): Promise<LatestOutcome<T>> {
			// A new call supersedes whatever is running.
			abortCurrent("superseded");

			const token = ++currentToken;
			const own = new AbortController();
			controller = own;

			try {
				const value = await task(own.signal);

				// A newer call started while this one was in flight: discard, so the
				// interleaved order cannot write an older result over a newer one.
				if (token !== currentToken) return { kind: "superseded" };

				return { kind: "result", value };
			} catch (error) {
				if (token !== currentToken) return { kind: "superseded" };
				throw error;
			} finally {
				if (token === currentToken) controller = undefined;
			}
		},

		cancel() {
			abortCurrent("cancelled");
			// Invalidate any in-flight call so its result is not written.
			currentToken += 1;
		},

		busy() {
			return controller !== undefined;
		},

		lastAbortReason() {
			return lastReason;
		},
	};
}

/**
 * Attribute an abort to a cause, distinguishing a superseded call from a user
 * cancellation and from a deadline.
 */
export function classifyAbort(options: {
	readonly signal?: AbortSignal;
	readonly superseded?: boolean;
	readonly timedOut?: boolean;
	readonly cancelledByUser?: boolean;
}): AbortReason | undefined {
	if (options.superseded) return "superseded";
	if (options.timedOut) return "timeout";
	if (options.cancelledByUser) return "cancelled";
	if (options.signal?.aborted) return "cancelled";
	return undefined;
}
