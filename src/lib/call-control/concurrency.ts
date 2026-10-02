/**
 * Per-connection concurrency limiter.
 *
 * Caps how many requests a single connection may have in flight at once
 * (default 2). Excess calls wait for a slot rather than firing concurrently, so
 * a burst cannot hammer one endpoint.
 *
 * A waiting call can be superseded while it waits: if a newer call arrives, the
 * older waiter must not go on to send a request once a slot frees up. That is
 * checked at the moment the slot is granted, not when the call was queued.
 */

/** Default simultaneous in-flight requests per connection. */
export const DEFAULT_MAX_IN_FLIGHT = 2;

/** Outcome of a queued call. */
export type SlotOutcome<T> =
	| { readonly kind: "result"; readonly value: T }
	| { readonly kind: "superseded" };

/** A limiter scoped to one key (in practice, one connection id). */
export interface ConcurrencyLimiter {
	/**
	 * Run `task` once a slot is free. `isLatest` is consulted when the slot is
	 * granted; returning `false` means a newer call took over, so no request is
	 * sent and the call resolves as superseded.
	 */
	run<T>(
		task: () => Promise<T>,
		isLatest?: () => boolean,
	): Promise<SlotOutcome<T>>;
	/** Slots currently in use. */
	active(): number;
	/** Calls waiting for a slot. */
	queued(): number;
}

interface Waiter {
	readonly start: () => void;
}

/** Create a limiter with the given maximum. */
export function createConcurrencyLimiter(
	maxInFlight = DEFAULT_MAX_IN_FLIGHT,
): ConcurrencyLimiter {
	let activeCount = 0;
	const waiters: Waiter[] = [];

	function release(): void {
		activeCount -= 1;
		const next = waiters.shift();
		if (next) next.start();
	}

	return {
		async run<T>(
			task: () => Promise<T>,
			isLatest?: () => boolean,
		): Promise<SlotOutcome<T>> {
			if (activeCount >= maxInFlight) {
				// Wait for a slot. The promise resolves when this waiter is granted
				// one; nothing runs until then.
				await new Promise<void>((resolve) => {
					waiters.push({ start: resolve });
				});
			}

			// The slot is ours, but a newer call may have replaced us while we
			// waited. Checked here so a stale waiter never sends a request.
			if (isLatest && !isLatest()) return { kind: "superseded" };

			activeCount += 1;
			try {
				return { kind: "result", value: await task() };
			} finally {
				release();
			}
		},

		active: () => activeCount,
		queued: () => waiters.length,
	};
}

/** A limiter per key, created on first use. */
export function createKeyedLimiters(maxInFlight = DEFAULT_MAX_IN_FLIGHT): {
	for(key: string): ConcurrencyLimiter;
	keys(): string[];
} {
	const limiters = new Map<string, ConcurrencyLimiter>();

	return {
		for(key) {
			const existing = limiters.get(key);
			if (existing) return existing;

			const created = createConcurrencyLimiter(maxInFlight);
			limiters.set(key, created);
			return created;
		},
		keys: () => [...limiters.keys()],
	};
}
