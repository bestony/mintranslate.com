/**
 * Speech controller.
 *
 * Owns two distinct policies that are easy to conflate:
 *
 * 1. **Between user requests**: latest wins. A second tap must not queue behind
 *    the first, so each trigger cancels whatever is playing.
 * 2. **Within one request**: segments play in order. Browsers truncate very long
 *    utterances, so a paragraph is spoken as a sequence — that is still one
 *    request, not a queue of user actions.
 *
 * The Web Speech API is reached through an injected interface rather than
 * `window.speechSynthesis` directly. Two reasons: the test environment has no DOM,
 * and the sequencing policy is the part worth testing — not the browser binding.
 *
 * Cancellation reuses `createLatestCall` from the shared call-control module
 * instead of a bespoke token, so "supersede the previous attempt" means the same
 * thing here as it does for translation requests.
 */

import { createLatestCall } from "../call-control/latest-call";
import { selectVoice, utteranceLang } from "./voice";

/** The narrow slice of the Web Speech API this module needs. */
export interface SpeechEngine {
	/** Whether speaking is possible at all. */
	isAvailable(): boolean;
	/**
	 * Speak one segment. Resolves when the segment finishes or is cancelled;
	 * rejects only on a genuine failure.
	 */
	speak(
		text: string,
		options: {
			readonly rate: number;
			readonly lang: string;
			readonly voiceName?: string;
		},
	): Promise<void>;
	/** Stop immediately and discard anything pending in the engine. */
	cancel(): void;
	/** Voices the engine currently knows about (may arrive asynchronously). */
	voices(): readonly {
		readonly name: string;
		readonly lang: string;
		readonly default?: boolean;
	}[];
	/**
	 * Subscribe to voice-list changes. Returns an unsubscribe function.
	 * Optional: engines that never report changes omit it.
	 */
	onVoicesChanged?(listener: () => void): () => void;
}

/** Callbacks the controller reports through. */
export interface SpeechControllerCallbacks {
	readonly onStateChange: (speaking: boolean) => void;
	readonly onError?: (error: unknown) => void;
}

export interface SpeechControllerDeps {
	readonly engine: SpeechEngine;
	readonly callbacks: SpeechControllerCallbacks;
	/** Splits text for sequential playback. Defaults to paragraph/sentence split. */
	readonly segment?: (text: string) => readonly string[];
}

/** Controller surface. */
export interface SpeechController {
	/** Speak the given segments, replacing anything in progress. */
	speak(
		text: string,
		options: { readonly rate: number; readonly language: string },
	): Promise<void>;
	/** Stop immediately and clear the queue. */
	stop(): void;
	/** Whether speech is currently in progress. */
	busy(): boolean;
	/** Whether the engine can speak at all. */
	available(): boolean;
	/** Release subscriptions; call when leaving the interface. */
	dispose(): void;
}

/** Default segmenter: split on blank lines and sentence ends, drop empties. */
function defaultSegments(text: string): readonly string[] {
	return text
		.split(/\n\s*\n|(?<=[.。！!？?；;])\s+/)
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

export function createSpeechController(
	deps: SpeechControllerDeps,
): SpeechController {
	const { engine, callbacks } = deps;
	const segment = deps.segment ?? defaultSegments;

	const latest = createLatestCall();
	/** Incremented on every stop, so a queued segment can tell it is stale. */
	let generation = 0;

	/**
	 * Voices often arrive after first paint, so the controller listens for changes
	 * and records the latest list. Reading it here (rather than calling
	 * `engine.voices()` at speak time) keeps the controller's view consistent with
	 * the events the engine reported.
	 */
	let knownVoices = engine.voices();
	let voiceSubscription: (() => void) | undefined;

	if (typeof engine.onVoicesChanged === "function") {
		voiceSubscription = engine.onVoicesChanged(() => {
			knownVoices = engine.voices();
		});
	}

	function stop(): void {
		generation += 1;
		latest.cancel();
		engine.cancel();
		callbacks.onStateChange(false);
	}

	return {
		async speak(text, options) {
			if (!engine.isAvailable()) return;

			const segments = segment(text);
			if (segments.length === 0) return;

			// A new user request supersedes whatever is playing and clears the
			// previous segment queue.
			const own = ++generation;
			engine.cancel();
			callbacks.onStateChange(true);

			const outcome = await latest.run(async (signal) => {
				for (const piece of segments) {
					// Superseded or stopped: do not read the rest of the queue.
					if (own !== generation || signal.aborted) return;

					// Re-read on each segment: a late-arriving voice list applies to the
					// remainder of this read too.
					const voice = selectVoice(knownVoices, options.language);
					await engine.speak(piece, {
						rate: options.rate,
						lang: utteranceLangFor(options.language),
						...(voice !== undefined && { voiceName: voice.name }),
					});
				}
			});

			// Only the current request may clear the speaking state; a superseded
			// one would otherwise report "stopped" while the new one is talking.
			if (outcome.kind !== "superseded" && own === generation) {
				callbacks.onStateChange(false);
			}
		},

		stop,

		busy: () => latest.busy(),

		available: () => engine.isAvailable(),

		dispose() {
			stop();
			voiceSubscription?.();
			voiceSubscription = undefined;
		},
	};
}

/** Language tag for an utterance. */
function utteranceLangFor(language: string): string {
	return utteranceLang(language);
}

/** Error reporting helper: a cancelled utterance is not a failure. */
export function isCancellation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { name?: unknown; message?: unknown };
	return (
		candidate.name === "AbortError" ||
		candidate.name === "SpeechSynthesisErrorEvent" ||
		(typeof candidate.message === "string" &&
			/cancel|interrupt/i.test(candidate.message))
	);
}
