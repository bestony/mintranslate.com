/**
 * Search input control: debounce plus latest-wins.
 *
 * The history search box has the same shape as the translation input — a burst
 * of events that must collapse into one action — so it reuses the same
 * primitives (`debounce`, `createLatestCall`) rather than growing its own timer.
 *
 * Kept free of React so the sequencing is directly testable with fake timers:
 * the React hook is a thin wrapper over this.
 */

import { type Debounced, debounce } from "../call-control/debounce";
import { createLatestCall } from "../call-control/latest-call";

/** Search debounce window. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Callbacks the controller drives. */
export interface SearchControlCallbacks<T> {
	/** A search is about to run. */
	readonly onPendingChange: (pending: boolean) => void;
	/** A search produced a result that is still current. */
	readonly onResult: (result: T) => void;
	/** The input became empty, so previous results no longer apply. */
	readonly onCleared: () => void;
}

export interface SearchControlDeps<T> {
	readonly run: (input: string, signal: AbortSignal) => Promise<T>;
	readonly callbacks: SearchControlCallbacks<T>;
	readonly waitMs?: number;
}

/** Input control surface. */
export interface SearchControl {
	/** Report new input; schedules a debounced search. */
	update(input: string): void;
	/** Run the pending search immediately. */
	runNow(): void;
	/** Drop a pending search and invalidate any in-flight one. */
	cancel(): void;
}

export function createSearchControl<T>(
	deps: SearchControlDeps<T>,
): SearchControl {
	const { run, callbacks } = deps;
	const latest = createLatestCall();

	const debounced: Debounced<[string]> = debounce((input: string) => {
		callbacks.onPendingChange(true);

		void latest
			.run(async (signal) => run(input, signal))
			.then((outcome) => {
				// A superseded search produced nothing worth showing: a newer one is
				// already on its way.
				if (outcome.kind === "superseded") return;
				callbacks.onResult(outcome.value);
				callbacks.onPendingChange(false);
			})
			.catch(() => {
				callbacks.onPendingChange(false);
			});
	}, deps.waitMs ?? SEARCH_DEBOUNCE_MS);

	return {
		update(input) {
			if (input === "") {
				// Clearing the box invalidates both a waiting and an in-flight search,
				// so a late result cannot repopulate an empty query.
				debounced.cancel();
				latest.cancel();
				callbacks.onPendingChange(false);
				callbacks.onCleared();
				return;
			}

			debounced(input);
		},

		runNow() {
			debounced.flush();
		},

		cancel() {
			debounced.cancel();
			latest.cancel();
		},
	};
}
