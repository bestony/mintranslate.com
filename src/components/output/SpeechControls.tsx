/**
 * Speech controls.
 *
 * Speech is a **global** resource: `window.speechSynthesis` plays one utterance at
 * a time, so starting the source while the target is speaking must stop the
 * target. That is why the engine and controller live in a single hook
 * (`useSpeech`) that the workspace calls once, while the buttons are placed in
 * whichever panel they belong to.
 *
 * An earlier revision rendered one component owning both sides and an entire row
 * of the layout. That coupled the audio model to the layout, which is exactly what
 * prevented the read-aloud controls from sitting in their own panels' toolbars.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logger } from "#/lib/logger";
import { createBrowserSpeechEngine } from "#/lib/speech/browser-engine";
import {
	createSpeechController,
	type SpeechController,
} from "#/lib/speech/controller";
import { loadSpeechRate, saveSpeechRate } from "#/lib/speech/persistence";
import {
	RATE_PREVIEW_TEXT,
	rateLabel,
	rateValue,
	SPEECH_RATES,
	type SpeechRate,
} from "#/lib/speech/rates";

/** Which side is currently speaking. */
export type SpeechSide = "source" | "target";

/** The speech capability, owned once by the workspace. */
export interface SpeechBinding {
	/** Whether the browser provides speech synthesis. Resolved after mount. */
	readonly available: boolean;
	readonly speakingSide: SpeechSide | undefined;
	readonly rate: SpeechRate;
	setRate(rate: SpeechRate): void;
	/** Speak this side, or stop it if it is already speaking. */
	toggle(side: SpeechSide, text: string, lang: string): void;
	stop(): void;
	/** Play a short sample at a candidate rate. */
	preview(rate: SpeechRate, lang: string): void;
}

/**
 * Own the speech engine, controller and rate preference.
 *
 * Call once per workspace. Passing the same `segment` used for rendering keeps
 * playback and display on one splitting rule.
 */
export function useSpeech(
	segment: (text: string) => readonly string[],
): SpeechBinding {
	const [rate, setRateState] = useState<SpeechRate>("normal");
	const [speakingSide, setSpeakingSide] = useState<SpeechSide | undefined>(
		undefined,
	);
	const controllerRef = useRef<SpeechController | undefined>(undefined);

	/** One engine for the workspace's lifetime. */
	const engine = useMemo(() => createBrowserSpeechEngine(), []);

	/**
	 * Availability is resolved after mount, never during render.
	 *
	 * The prerender has no `speechSynthesis`, so `isAvailable()` is false there.
	 * Reading it during render would make the first client render (where it is
	 * true) disagree with the prerendered HTML — the two disagree not just in text
	 * but in structure, because the notice below is conditional. React then
	 * discards the prerendered tree, which is what the browser reports as
	 * `Minified React error #418`.
	 */
	const [available, setAvailable] = useState(false);

	useEffect(() => {
		setAvailable(engine.isAvailable());
	}, [engine]);

	// The controller reports through state rather than owning it, so a superseded
	// read cannot leave the interface claiming to be speaking.
	const controller = useMemo(
		() =>
			createSpeechController({
				engine,
				segment,
				callbacks: {
					onStateChange: (speaking) => {
						if (!speaking) setSpeakingSide(undefined);
					},
				},
			}),
		[engine, segment],
	);

	controllerRef.current = controller;

	// Restore the saved rate once, and stop speech on unmount.
	useEffect(() => {
		setRateState(loadSpeechRate());
		return () => controller.dispose();
	}, [controller]);

	// Never leave audio playing after the workspace goes away. Speech is global
	// state, so a lingering utterance would outlive the interface that started it.
	useEffect(
		() => () => {
			try {
				controller.stop();
			} catch {
				// A disposed engine cannot stop; nothing to do.
			}
		},
		[controller],
	);

	const toggle = useCallback<SpeechBinding["toggle"]>(
		(side, text, lang) => {
			if (text.trim() === "") return;

			// Toggling the active side stops it; toggling the other side switches,
			// which is why the controller is asked to stop first.
			if (speakingSide === side) {
				controller.stop();
				setSpeakingSide(undefined);
				return;
			}

			controller.stop();
			setSpeakingSide(side);

			void controller
				.speak(text, { rate: rateValue(rate), language: lang })
				.catch((error: unknown) => {
					logger.warn("speech.failed", { error });
					setSpeakingSide(undefined);
				});
		},
		[controller, rate, speakingSide],
	);

	const stop = useCallback(() => {
		controller.stop();
		setSpeakingSide(undefined);
	}, [controller]);

	const setRate = useCallback((next: SpeechRate) => {
		setRateState(next);
		saveSpeechRate(next);
	}, []);

	const preview = useCallback(
		(next: SpeechRate, lang: string) => {
			setSpeakingSide(undefined);
			void controller
				.speak(RATE_PREVIEW_TEXT, { rate: rateValue(next), language: lang })
				.catch(() => {
					// A preview failure needs no report; the rate still applies.
				});
		},
		[controller],
	);

	return { available, speakingSide, rate, setRate, toggle, stop, preview };
}

/** Colour a disabled control's explanation. */
function blockedReason(available: boolean, text: string): string {
	if (!available) return "当前浏览器不支持语音朗读";
	return text;
}

/**
 * Read-aloud control for one panel.
 *
 * Presentational only: the audio itself belongs to the binding, so placing this in
 * either panel cannot start a second engine.
 */
export function SpeechButton({
	side,
	label,
	binding,
	text,
	lang,
}: {
	readonly side: SpeechSide;
	readonly label: string;
	readonly binding: SpeechBinding;
	readonly text: string;
	readonly lang: string;
}) {
	const empty = text.trim() === "";
	const speaking = binding.speakingSide === side;

	return (
		<button
			type="button"
			// 44px minimum touch target via padding, not font size.
			className="nav-link min-h-11 text-xs disabled:opacity-40"
			disabled={!binding.available || empty}
			title={
				binding.available
					? empty
						? "没有可朗读的内容"
						: undefined
					: blockedReason(binding.available, "")
			}
			aria-pressed={speaking}
			onClick={() => binding.toggle(side, text, lang)}
		>
			{speaking ? `停止${label}` : label}
		</button>
	);
}

/**
 * Speaking-rate control.
 *
 * Lives beside the read-aloud control it affects. The rate is shared by both
 * sides, so one control reflects and changes it for all of them.
 */
export function SpeechRateControl({
	binding,
	lang,
}: {
	readonly binding: SpeechBinding;
	readonly lang: string;
}) {
	const [open, setOpen] = useState(false);

	return (
		<>
			<button
				type="button"
				className="nav-link min-h-11 text-xs disabled:opacity-40"
				disabled={!binding.available}
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				语速：{rateLabel(binding.rate)}
			</button>

			{open && binding.available && (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface min-h-11 px-2">
					{SPEECH_RATES.map((tier) => (
						// grid-exception: 4px between a rate button and its preview action
						<div key={tier} className="flex items-center gap-1">
							<button
								type="button"
								className={
									binding.rate === tier
										? "min-h-11 rounded-sm border border-primary bg-primary/10 px-2 text-xs"
										: "min-h-11 rounded-sm border border-border px-2 text-xs"
								}
								aria-pressed={binding.rate === tier}
								onClick={() => binding.setRate(tier)}
							>
								{rateLabel(tier)}
							</button>
							<button
								type="button"
								className="nav-link min-h-11 text-xs"
								onClick={() => binding.preview(tier, lang)}
							>
								试听
							</button>
						</div>
					))}
				</div>
			)}
		</>
	);
}
