/**
 * Speech controls.
 *
 * Binds the tested speech logic (`src/lib/speech`) to the interface. The only
 * browser-specific part — `window.speechSynthesis` — comes in through the
 * engine factory, so this component contains no speech policy of its own.
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

interface SpeechControlsProps {
	/** Text shown in the source area. */
	readonly sourceText: string;
	readonly sourceLang: string;
	/** Text shown in the result area. */
	readonly targetText: string;
	readonly targetLang: string;
	/**
	 * Splits text for sequential playback. Supplied by the workspace so speech
	 * uses exactly the same segmentation as the rendered result.
	 */
	readonly segment: (text: string) => readonly string[];
}

/** A single speak/stop button pair for one side. */
function SpeakButton({
	label,
	disabled,
	reason,
	speaking,
	onSpeak,
	onStop,
}: {
	readonly label: string;
	readonly disabled: boolean;
	readonly reason?: string;
	readonly speaking: boolean;
	readonly onSpeak: () => void;
	readonly onStop: () => void;
}) {
	return (
		<button
			type="button"
			className="nav-link text-xs disabled:opacity-40"
			disabled={disabled}
			title={disabled ? reason : undefined}
			aria-pressed={speaking}
			onClick={speaking ? onStop : onSpeak}
		>
			{speaking ? `停止${label}` : label}
		</button>
	);
}

export function SpeechControls({
	sourceText,
	sourceLang,
	targetText,
	targetLang,
	segment,
}: SpeechControlsProps) {
	const [rate, setRate] = useState<SpeechRate>("normal");
	const [speakingSide, setSpeakingSide] = useState<
		"source" | "target" | undefined
	>(undefined);
	const [showRates, setShowRates] = useState(false);
	const controllerRef = useRef<SpeechController | undefined>(undefined);

	/** One engine for the component's lifetime. */
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
		setRate(loadSpeechRate());
		return () => controller.dispose();
	}, [controller]);

	const speak = useCallback(
		async (side: "source" | "target") => {
			const text = side === "source" ? sourceText : targetText;
			const language = side === "source" ? sourceLang : targetLang;
			if (text.trim() === "") return;

			setSpeakingSide(side);
			try {
				await controller.speak(text, { rate: rateValue(rate), language });
			} catch (error) {
				logger.warn("speech.failed", { error });
				setSpeakingSide(undefined);
			}
		},
		[controller, rate, sourceLang, sourceText, targetLang, targetText],
	);

	function preview(tier: SpeechRate) {
		setSpeakingSide(undefined);
		void controller.speak(RATE_PREVIEW_TEXT, {
			rate: rateValue(tier),
			language: targetLang,
		});
	}

	function chooseRate(tier: SpeechRate) {
		setRate(tier);
		saveSpeechRate(tier);
	}

	const sourceBlocked = !available || sourceText.trim() === "";
	const targetBlocked = !available || targetText.trim() === "";
	const unavailableReason = available
		? "没有可朗读的内容"
		: "当前浏览器不支持语音朗读";

	return (
		<div className="flex flex-wrap items-center gap-3">
			<SpeakButton
				label="朗读原文"
				disabled={sourceBlocked}
				reason={unavailableReason}
				speaking={speakingSide === "source"}
				onSpeak={() => void speak("source")}
				onStop={() => controller.stop()}
			/>
			<SpeakButton
				label="朗读译文"
				disabled={targetBlocked}
				reason={unavailableReason}
				speaking={speakingSide === "target"}
				onSpeak={() => void speak("target")}
				onStop={() => controller.stop()}
			/>

			<button
				type="button"
				className="nav-link text-xs disabled:opacity-40"
				disabled={!available}
				aria-expanded={showRates}
				onClick={() => setShowRates((current) => !current)}
			>
				语速：{rateLabel(rate)}
			</button>

			{!available && (
				<span className="text-muted-foreground text-xs">
					当前环境不支持语音朗读，朗读入口已禁用。
				</span>
			)}

			{showRates && available && (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface/60 px-2 py-1">
					{SPEECH_RATES.map((tier) => (
						<div key={tier} className="flex items-center gap-1">
							<button
								type="button"
								className={
									rate === tier
										? "rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-xs"
										: "rounded-full border border-input px-2 py-0.5 text-xs"
								}
								aria-pressed={rate === tier}
								onClick={() => chooseRate(tier)}
							>
								{rateLabel(tier)}
							</button>
							<button
								type="button"
								className="nav-link text-xs"
								onClick={() => preview(tier)}
							>
								试听
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
