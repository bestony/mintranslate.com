/**
 * Web Speech API binding.
 *
 * The only module that touches `window.speechSynthesis`. Everything worth
 * deciding (voice choice, rate, cancellation, segment ordering) lives in the
 * DOM-free modules and is tested there; this file is deliberately thin and
 * untested by unit tests — it is exercised by the real-browser verification step.
 */

import type { SpeechEngine } from "./controller";

/** Minimal structural types, so this compiles without `lib.dom` speech classes. */
interface UtteranceLike {
	text: string;
	rate: number;
	lang: string;
	voice: unknown;
	onend: (() => void) | null;
	onerror: ((event: unknown) => void) | null;
}

interface SynthesisLike {
	speak(utterance: UtteranceLike): void;
	cancel(): void;
	getVoices(): readonly {
		readonly name: string;
		readonly lang: string;
		readonly default?: boolean;
	}[];
	addEventListener?(type: string, listener: () => void): void;
	removeEventListener?(type: string, listener: () => void): void;
}

interface SpeechGlobals {
	readonly speechSynthesis?: SynthesisLike;
	readonly SpeechSynthesisUtterance?: new (text: string) => UtteranceLike;
}

/** Access the browser speech globals without assuming they exist. */
function speechGlobals(): SpeechGlobals {
	return globalThis as unknown as SpeechGlobals;
}

/**
 * Create an engine backed by `window.speechSynthesis`.
 *
 * When the API is missing, `isAvailable()` returns false and the other methods
 * become no-ops: the caller reports "unavailable" rather than the app throwing.
 */
export function createBrowserSpeechEngine(): SpeechEngine {
	const globals = speechGlobals();
	const synthesis = globals.speechSynthesis;
	const Utterance = globals.SpeechSynthesisUtterance;

	if (!synthesis || !Utterance) {
		return {
			isAvailable: () => false,
			speak: async () => {},
			cancel: () => {},
			voices: () => [],
		};
	}

	return {
		isAvailable: () => true,

		speak(text, options) {
			return new Promise<void>((resolve, reject) => {
				const utterance = new Utterance(text);
				utterance.rate = options.rate;
				utterance.lang = options.lang;

				// Leaving `voice` null lets the browser choose from `lang`, which is
				// the documented fallback when no explicit voice matched.
				utterance.voice = null;
				if (options.voiceName !== undefined) {
					const match = synthesis
						.getVoices()
						.find((voice) => voice.name === options.voiceName);
					if (match) utterance.voice = match;
				}

				utterance.onend = () => resolve();
				utterance.onerror = (event) => {
					// `interrupted`/`canceled` occur on every intentional stop; treating
					// them as failures would surface phantom errors on each re-read.
					const error = (event as { error?: string } | undefined)?.error;
					if (error === "interrupted" || error === "canceled") resolve();
					else reject(event);
				};

				synthesis.speak(utterance);
			});
		},

		cancel() {
			synthesis.cancel();
		},

		voices() {
			return synthesis.getVoices();
		},

		onVoicesChanged(listener) {
			if (typeof synthesis.addEventListener !== "function") return () => {};

			synthesis.addEventListener("voiceschanged", listener);
			return () => synthesis.removeEventListener?.("voiceschanged", listener);
		},
	};
}
