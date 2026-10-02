/**
 * Speech rate persistence.
 *
 * Stored in `localStorage` alongside the other small user preferences, using the
 * same slot naming convention as the connection settings. Reads are defensive:
 * the stored value is user-visible through devtools and may be anything, so an
 * invalid entry falls back to the default rather than breaking the interface.
 */

import { DEFAULT_SPEECH_RATE, isSpeechRate, type SpeechRate } from "./rates";

/** Storage slot for the chosen rate tier. */
export const SPEECH_RATE_KEY = "mintranslate.speech-rate.v1";

/** Minimal storage surface, satisfied by `localStorage` and by test doubles. */
export interface RateStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** Resolve the browser's `localStorage`, or `undefined` when unavailable. */
function browserStorage(): RateStorage | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		// Storage can be blocked (private mode, enterprise policy).
		return undefined;
	}
}

/** Read the stored tier, falling back to the default. */
export function loadSpeechRate(
	storage: RateStorage | undefined = browserStorage(),
): SpeechRate {
	if (!storage) return DEFAULT_SPEECH_RATE;

	try {
		const raw = storage.getItem(SPEECH_RATE_KEY);
		return isSpeechRate(raw) ? raw : DEFAULT_SPEECH_RATE;
	} catch {
		return DEFAULT_SPEECH_RATE;
	}
}

/** Persist the chosen tier. Failures are ignored: a preference is not worth an error. */
export function saveSpeechRate(
	rate: SpeechRate,
	storage: RateStorage | undefined = browserStorage(),
): void {
	if (!storage) return;

	try {
		storage.setItem(SPEECH_RATE_KEY, rate);
	} catch {
		// Ignored on purpose; see the doc comment.
	}
}
