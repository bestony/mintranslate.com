/**
 * React wrapper around the search input control.
 *
 * The debounce and latest-wins sequencing lives in
 * `src/lib/history/search-control.ts` and is tested there; this hook only binds
 * it to React state. Keeping the logic out of the component is what makes the
 * ordering assertions possible without rendering anything.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
	createSearchControl,
	SEARCH_DEBOUNCE_MS,
} from "#/lib/history/search-control";

export { SEARCH_DEBOUNCE_MS };

/** State of a debounced search. */
export interface DebouncedSearch<T> {
	/** The value typed by the user; updates immediately. */
	readonly input: string;
	readonly setInput: (value: string) => void;
	/** Result of the most recent non-superseded search. */
	readonly result: T | undefined;
	/** True while a search is waiting or running. */
	readonly pending: boolean;
	/** Run the pending search immediately. */
	readonly runNow: () => void;
}

/**
 * Run `search` against the debounced input.
 *
 * `search` receives an `AbortSignal` so a superseded query can stop early; even
 * if it ignores the signal its result is discarded.
 */
export function useDebouncedSearch<T>(
	search: (input: string, signal: AbortSignal) => Promise<T>,
): DebouncedSearch<T> {
	const [input, setInput] = useState("");
	const [result, setResult] = useState<T | undefined>(undefined);
	const [pending, setPending] = useState(false);

	const searchRef = useRef(search);
	searchRef.current = search;

	const control = useMemo(
		() =>
			createSearchControl<T>({
				run: (value, signal) => searchRef.current(value, signal),
				callbacks: {
					onResult: (value) => {
						setResult(value);
						setPending(false);
					},
					onPendingChange: setPending,
					onCleared: () => {
						setResult(undefined);
						setPending(false);
					},
				},
			}),
		[],
	);

	// Stop any pending or in-flight search when the component goes away.
	useEffect(() => () => control.cancel(), [control]);

	return {
		input,
		setInput: (value: string) => {
			setInput(value);
			control.update(value);
		},
		result,
		pending,
		runNow: () => control.runNow(),
	};
}
