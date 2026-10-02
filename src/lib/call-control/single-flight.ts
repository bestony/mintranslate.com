/**
 * Single-flight.
 *
 * Collapses concurrent calls for the same key into one real call, so N callers
 * arriving while a call is in progress share its result instead of producing N
 * requests. Different keys never merge or block each other.
 *
 * The in-flight entry is removed when the call settles, so a later call with
 * the same key starts fresh rather than reusing a stale result. This is
 * deliberately not a cache: caching is a separate concern with separate
 * invalidation rules.
 */

/** A map of in-flight promises keyed by string. */
export type SingleFlight<K extends string, V> = (
	key: K,
	run: () => Promise<V>,
) => Promise<V>;

/**
 * Create a single-flight wrapper.
 *
 * Failures are shared with every waiting caller, and the key is released
 * afterwards so the operation can be retried.
 */
export function createSingleFlight<
	K extends string = string,
	V = unknown,
>(): SingleFlight<K, V> {
	const inFlight = new Map<K, Promise<V>>();

	return (key, run) => {
		const existing = inFlight.get(key);
		if (existing) return existing;

		// Start the call, then register it. Registering after `run()` is called
		// but before awaiting keeps a synchronous re-entrant call from starting a
		// second request.
		const started = run();

		const tracked = started.finally(() => {
			// Only clear the entry this call owns: a later call may have replaced
			// it after this one settled.
			if (inFlight.get(key) === tracked) inFlight.delete(key);
		});

		inFlight.set(key, tracked);
		return tracked;
	};
}

/** Whether a key currently has a call in progress. */
export function createSingleFlightWithState<
	K extends string = string,
	V = unknown,
>(): {
	run: SingleFlight<K, V>;
	has: (key: K) => boolean;
	size: () => number;
} {
	const inFlight = new Map<K, Promise<V>>();

	return {
		run: (key, runner) => {
			const existing = inFlight.get(key);
			if (existing) return existing;

			const tracked = runner().finally(() => {
				if (inFlight.get(key) === tracked) inFlight.delete(key);
			});

			inFlight.set(key, tracked);
			return tracked;
		},
		has: (key) => inFlight.has(key),
		size: () => inFlight.size,
	};
}
