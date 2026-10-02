/**
 * Translation workspace.
 *
 * Composition only: it reads the connection store, drives the translation
 * controller, and renders. All the rules it depends on live elsewhere and are
 * tested there:
 *
 * - when to send a request → `src/lib/translation/controller.ts`
 * - how a call is made safely → `src/lib/connections/model-caller.ts`
 * - result segmentation, counting, copying → `src/lib/translation/result.ts`
 * - logging → `src/lib/logger`
 *
 * The one thing this file must not do is talk to a provider directly. Its only
 * network path is `model-caller`.
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createAnalytics,
	createThrottledSubmit,
	reportedHost,
} from "#/lib/analytics/track";
import { createKeyedLimiters } from "#/lib/call-control/concurrency";
import { attributeFailure } from "#/lib/connections/attribution";
import type { Connection, ProviderId } from "#/lib/connections/model";
import { createModelCaller } from "#/lib/connections/model-caller";
import { CUSTOM_INSTRUCTION_KEY, STYLE_KEY } from "#/lib/connections/storage";
import { useConnectionStore } from "#/lib/connections/store";
import {
	assemblePrompt,
	isTranslationStyleId,
	type TranslationStyleId,
} from "#/lib/connections/styles";
import {
	DEFAULT_RECORD_LIMIT,
	evictOverLimit,
	openHistoryDatabase,
	setFavorite,
	writeRecord,
} from "#/lib/history/db";
import {
	AUTO_DETECT,
	canSwap,
	DEFAULT_TARGET,
	isTargetLanguage,
	languageName,
	quickLanguages,
	resolveTargetConflict,
	swapPair,
} from "#/lib/languages";
import { logger } from "#/lib/logger";
import { createTranslationController } from "#/lib/translation/controller";
import {
	acceptInput,
	COPY_FEEDBACK_MS,
	copyPlainText,
	countCharacters,
	counterLabel,
	counterState,
	segmentTranslation,
	toPlainText,
	truncationNotice,
} from "#/lib/translation/result";
import { fromQueryString, writeWorkspaceUrl } from "#/lib/url-state";
import { FeedbackPanel } from "../output/FeedbackPanel";
import { SearchLookupButton } from "../output/SearchLookupButton";
import { ShareMenu } from "../output/ShareMenu";
import {
	SpeechButton,
	SpeechRateControl,
	useSpeech,
} from "../output/SpeechControls";
import { LanguagePicker, languageChipLabel } from "./LanguagePicker";

/**
 * How the modifier key is shown for the current platform.
 *
 * Deliberately returns the non-Mac label until the platform is read after mount.
 * Reading `navigator` during render makes the server's prerendered text ("Ctrl",
 * because the prerender has no `navigator`) differ from the first client render
 * ("⌘" on a Mac), which React reports as a hydration mismatch and then discards
 * the whole prerendered tree for.
 */
function useModifierLabel(): string {
	const [label, setLabel] = useState("Ctrl");

	useEffect(() => {
		setLabel(
			/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
				? "⌘"
				: "Ctrl",
		);
	}, []);

	return label;
}

/** One connection's limiter set, shared across the component's lifetime. */
const limiters = createKeyedLimiters(2);

export function TranslationWorkspace() {
	const store = useConnectionStore();
	const modifier = useModifierLabel();
	const [sourceLang, setSourceLang] = useState(AUTO_DETECT);
	const [targetLang, setTargetLang] = useState<string>(DEFAULT_TARGET);
	const [text, setText] = useState("");
	const [output, setOutput] = useState("");
	const [pending, setPending] = useState(false);
	const [detected, setDetected] = useState<string | undefined>(undefined);

	// `detectedRef` mirrors `detected` so the success callback can read the value
	// without re-creating the controller on every detection change.
	useEffect(() => {
		detectedRef.current = detected;
	}, [detected]);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const [picker, setPicker] = useState<"source" | "target" | undefined>(
		undefined,
	);
	const [copied, setCopied] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	/**
	 * The history database, opened on first use.
	 *
	 * `undefined` means "not opened yet" and `null` means "unavailable": history
	 * is optional, so a browser that refuses IndexedDB must not affect
	 * translation at all.
	 */
	const historyDb = useRef<Promise<IDBDatabase | null> | null>(null);
	/** Start time of the in-flight translation, for an optional duration field. */
	const runStartedAt = useRef<number | undefined>(undefined);
	/** Input that produced the in-flight request, captured at send time. */
	const lastInput = useRef<
		{ text: string; sourceLang: string; targetLang: string } | undefined
	>(undefined);
	/** Latest detected language, readable from the success callback. */
	const detectedRef = useRef<string | undefined>(undefined);
	/** Id of the record written for the most recent success, for the save button. */
	const [lastRecordId, setLastRecordId] = useState<string | undefined>(
		undefined,
	);
	const [saved, setSaved] = useState(false);

	/** Open the history database once, caching the outcome. */
	const getHistoryDb = useCallback(async (): Promise<IDBDatabase | null> => {
		if (historyDb.current === null) {
			historyDb.current = openHistoryDatabase().then((result) => {
				if (!result.ok) {
					logger.warn("history.open.failed", { reason: result.reason });
					return null;
				}
				return result.db;
			});
		}
		return historyDb.current;
	}, []);
	/** Prompt style and custom instruction, as configured in settings. */
	const [promptStyle, setPromptStyle] = useState<TranslationStyleId>("free");
	const [customInstruction, setCustomInstruction] = useState("");

	const active: Connection | undefined = store.activeConnection;
	const activeId = active?.id;

	/**
	 * Analytics entry point.
	 *
	 * Created once; the connection state is read through a closure so the tracker
	 * does not need rebuilding when a connection is added.
	 */
	const analytics = useMemo(
		() => createAnalytics({ byokConfigured: () => store.activeId !== null }),
		[store],
	);

	/**
	 * Throttled submit reporter.
	 *
	 * `translate_submit` fires on every pause in typing; the throttle collapses a
	 * burst while the terminal events (success/error) are sent unthrottled so the
	 * funnel keeps exact counts.
	 */
	const reportSubmit = useMemo(
		() =>
			createThrottledSubmit((event, params) => {
				if (event === "translate_submit")
					analytics.track("translate_submit", params);
			}),
		[analytics],
	);

	/**
	 * Report a language change.
	 *
	 * `trigger` distinguishes how the user changed it, which is what tells us
	 * whether the quick chips or the searchable list is doing the work.
	 */
	const reportLanguageChange = useCallback(
		(options: {
			readonly side: "source" | "target";
			readonly from: string;
			readonly to: string;
			readonly trigger: "chip" | "search_list" | "swap" | "url";
		}) => {
			if (options.from === options.to) return;

			analytics.track("lang_change", {
				side: options.side,
				from_lang: options.from,
				to_lang: options.to,
				is_auto_detect: options.to === AUTO_DETECT,
				trigger: options.trigger,
			});
		},
		[analytics],
	);

	/** Single caller instance: it owns the per-connection limits and flights. */
	const caller = useMemo(
		() => createModelCaller({ limiterFor: (id) => limiters.for(id) }),
		[],
	);

	// Pick up the style chosen in settings. Read once: the workspace does not own
	// these values, it only consumes them.
	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			const storedStyle = window.localStorage.getItem(STYLE_KEY);
			if (isTranslationStyleId(storedStyle)) setPromptStyle(storedStyle);
			setCustomInstruction(
				window.localStorage.getItem(CUSTOM_INSTRUCTION_KEY) ?? "",
			);
		} catch {
			// Storage unavailable: keep the defaults.
		}
	}, []);

	// Restore state from the URL once, on mount. `fromQueryString` never returns
	// an unbounded text value, so a shared link cannot overflow the input.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const restored = fromQueryString(window.location.search);
		if (restored.sourceLang !== undefined) {
			reportLanguageChange({
				side: "source",
				from: AUTO_DETECT,
				to: restored.sourceLang,
				trigger: "url",
			});
			setSourceLang(restored.sourceLang);
		}
		if (
			restored.targetLang !== undefined &&
			isTargetLanguage(restored.targetLang)
		) {
			setTargetLang(restored.targetLang);
		}
		if (restored.text !== undefined) setText(restored.text);
	}, [reportLanguageChange]);

	// Mirror state into the URL. `writeWorkspaceUrl` uses replaceState only.
	useEffect(() => {
		if (typeof window === "undefined") return;
		writeWorkspaceUrl({ sourceLang, targetLang, text, mode: "translate" });
	}, [sourceLang, targetLang, text]);

	/**
	 * Write one finished translation to local history.
	 *
	 * Called only from the success callback. Failures are logged and swallowed:
	 * history is a convenience, and a storage problem must never surface as a
	 * translation error.
	 */
	const persistHistory = useCallback(
		async (entry: {
			readonly sourceText: string;
			readonly targetText: string;
			readonly sourceLang: string;
			readonly targetLang: string;
			readonly model: string;
			readonly detectedLang?: string;
			readonly durationMs?: number;
		}) => {
			if (entry.sourceText.trim() === "" || entry.targetText.trim() === "")
				return;

			try {
				const db = await getHistoryDb();
				if (!db) return;

				const result = await writeRecord(db, {
					sourceText: entry.sourceText,
					targetText: entry.targetText,
					sourceLang: entry.sourceLang,
					targetLang: entry.targetLang,
					model: entry.model,
					...(entry.detectedLang !== undefined && {
						detectedLang: entry.detectedLang,
					}),
					...(entry.durationMs !== undefined && {
						durationMs: entry.durationMs,
					}),
				});

				if (!result.ok) {
					logger.warn("history.write.failed", { reason: result.reason });
					return;
				}

				setLastRecordId(result.record.id);
				// A fresh success is not the saved state of the previous one.
				setSaved(result.record.favorite);

				const evicted = await evictOverLimit(db, DEFAULT_RECORD_LIMIT);
				logger.info("history.write.done", {
					inserted: result.inserted,
					evicted,
					textLength: entry.sourceText.length,
				});
			} catch (error) {
				logger.warn("history.write.error", { error });
			}
		},
		[getHistoryDb],
	);

	const controller = useMemo(
		() =>
			createTranslationController({
				callbacks: {
					onStart: () => {
						setPending(true);
						setFailure(undefined);
						setOutput("");

						// Reported from current state: the runner captures the request input
						// immediately after this callback, so `lastInput` still holds the
						// previous request at this point.
						reportSubmit({
							mode: "text",
							source_lang: sourceLang,
							target_lang: targetLang,
							input_chars: text.length,
							input_kind: "text",
						});
					},
					onChunk: (_id, delta) => setOutput((current) => current + delta),
					onSuccess: (_id, result) => {
						setOutput(result);
						setPending(false);
						// Feeds the quick-switch chips with the user's real habits.
						store.noteLanguageUse(targetLang);

						// Terminal event: sent unthrottled, because these counts are the
						// funnel's denominator. Latency is measured from the request start
						// recorded in the runner, so the analytics call cannot shift it.
						const latencyMs =
							runStartedAt.current === undefined
								? 0
								: Date.now() - runStartedAt.current;
						analytics.track("translate_success", {
							mode: "text",
							source_lang: lastInput.current?.sourceLang ?? sourceLang,
							target_lang: lastInput.current?.targetLang ?? targetLang,
							provider: (active?.provider ?? "custom") as ProviderId,
							model: active?.model ?? "",
							latency_ms: latencyMs,
							is_streaming: true,
						});
						analytics.track("model_in_use", {
							provider: (active?.provider ?? "custom") as ProviderId,
							model: active?.model ?? "",
						});

						// History is written here and only here: `onSuccess` fires for the
						// final result of a request that was not superseded, so streaming
						// chunks and abandoned requests never reach the store. That also
						// means no extra debounce is needed on this path.
						void persistHistory({
							sourceText: lastInput.current?.text ?? "",
							targetText: result,
							sourceLang: lastInput.current?.sourceLang ?? sourceLang,
							targetLang: lastInput.current?.targetLang ?? targetLang,
							model: active?.model ?? "",
							detectedLang: detectedRef.current,
							durationMs:
								runStartedAt.current === undefined
									? undefined
									: Date.now() - runStartedAt.current,
						});
					},
					onFailure: (_id, error) => {
						// The input is deliberately left untouched, and any previous
						// successful output stays until a new success replaces it.
						setPending(false);
						const attribution = attributeFailure({ error });
						logger.warn("translation.ui.failure", {
							errorType: attribution.type,
						});
						setFailure(attribution.summary);

						const provider = (active?.provider ?? "custom") as ProviderId;
						const model = active?.model ?? "";

						analytics.track("translate_error", {
							mode: "text",
							provider,
							model,
							error_type: attribution.type,
						});

						// Cross-origin failures are reported separately, and only when that
						// is genuinely the attribution: a user cancellation or an inherent
						// front-end limitation must not skew the provider-compatibility
						// signal. The host is hashed for custom endpoints by `reportedHost`.
						if (
							attribution.type === "cors_or_network" &&
							active !== undefined
						) {
							void reportedHost(
								active.endpoint,
								active.provider === "custom",
							).then((host) => {
								if (host === undefined) return;
								analytics.track("cors_blocked", {
									provider,
									endpoint_host: host,
								});
							});
						}
					},
					onSuperseded: () => {
						// A newer request is already in flight; it owns the pending flag.
						// No history write: an abandoned request is not a translation the
						// user asked to keep.
					},
				},
				run: async ({ input, signal, onChunk, requestId }) => {
					if (!active) throw new Error("no active connection");
					runStartedAt.current = Date.now();
					// Capture the input this request was built from, so the success
					// callback records what was sent rather than whatever is in the box
					// by the time the response arrives.
					lastInput.current = {
						text: input.text,
						sourceLang: input.sourceLang,
						targetLang: input.targetLang,
					};

					const prompt = assemblePrompt({
						styleId: promptStyle,
						customInstruction: customInstruction,
						text: input.text,
					});

					const outcome = await caller.call({
						connection: active,
						apiKey: store.keyFor(active.id),
						requirement: "text",
						systemInstruction: prompt.systemInstruction,
						userContent: prompt.userContent,
						onChunk,
					});

					if (outcome.kind === "refused") {
						if (outcome.refusal.kind === "superseded") {
							throw Object.assign(new Error("superseded"), {
								name: "SupersededError",
							});
						}
						throw new Error(outcome.refusal.reason);
					}

					// Detect-language回显: the model's answer is the only signal we have.
					if (input.sourceLang === AUTO_DETECT && detected === undefined) {
						setDetected(input.targetLang === "en" ? "zh-Hans" : "en");
					}

					logger.debug("translation.run.done", {
						requestId,
						signal: signal.aborted,
					});
					return { text: outcome.text };
				},
			}),
		[
			active,
			caller,
			store,
			detected,
			promptStyle,
			customInstruction,
			targetLang,
			persistHistory,
			sourceLang,
			analytics.track, // Reported from current state: the runner captures the request input
			// immediately after this callback, so `lastInput` still holds the
			// previous request at this point.
			reportSubmit,
			text.length,
		],
	);

	// Feed the controller every time the input state changes.
	useEffect(() => {
		controller.update({
			text,
			sourceLang,
			targetLang,
			connectionId: activeId,
			composing: false,
		});
	}, [controller, text, sourceLang, targetLang, activeId]);

	const characters = countCharacters(text);
	const state = counterState(characters);
	const segments = useMemo(() => segmentTranslation(output), [output]);

	const swap = useCallback(() => {
		if (!canSwap(sourceLang)) return;
		const next = swapPair({ source: sourceLang, target: targetLang });
		reportLanguageChange({
			side: "source",
			from: sourceLang,
			to: next.source,
			trigger: "swap",
		});
		setSourceLang(next.source);
		setTargetLang(next.target);
		// Re-translate immediately in the new direction.
		controller.trigger();
	}, [controller, sourceLang, targetLang, reportLanguageChange]);

	const pickLanguage = useCallback(
		(code: string) => {
			if (picker === "source") {
				reportLanguageChange({
					side: "source",
					from: sourceLang,
					to: code,
					trigger: "search_list",
				});
				if (code === AUTO_DETECT) {
					setSourceLang(AUTO_DETECT);
					setDetected(undefined);
				} else {
					// Keep the user's choice; move the other side if it collides.
					const resolved = resolveTargetConflict(
						{ source: code, target: targetLang },
						[targetLang],
					);
					setSourceLang(code);
					setTargetLang(resolved.pair.target);
					if (resolved.notice) setNotice(resolved.notice);
				}
			} else if (picker === "target") {
				if (!isTargetLanguage(code)) return;
				reportLanguageChange({
					side: "target",
					from: targetLang,
					to: code,
					trigger: "search_list",
				});
				const resolved = resolveTargetConflict(
					{ source: sourceLang, target: code },
					[sourceLang],
				);
				setTargetLang(code);
				setSourceLang(resolved.pair.source);
				if (resolved.notice) setNotice(resolved.notice);
			}
			setPicker(undefined);
		},
		[picker, sourceLang, targetLang, reportLanguageChange],
	);

	// Global shortcuts. The manual path bypasses the debounce by design.
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const meta = event.metaKey || event.ctrlKey;
			if (meta && event.key === "Enter") {
				event.preventDefault();
				controller.trigger();
				return;
			}
			if (meta && event.shiftKey && (event.key === "s" || event.key === "S")) {
				event.preventDefault();
				swap();
				return;
			}
			if (event.key === "Escape" && picker !== undefined) {
				event.preventDefault();
				setPicker(undefined);
			}
		}

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [controller, swap, picker]);

	/** Mark the record written for the latest translation as a favourite. */
	async function toggleSaved() {
		if (lastRecordId === undefined) return;
		try {
			const db = await getHistoryDb();
			if (!db) return;

			const next = !saved;
			await setFavorite(db, lastRecordId, next);
			setSaved(next);
			logger.debug("history.favorite.toggled", { favorite: next });
		} catch (error) {
			logger.warn("history.favorite.failed", { error });
		}
	}

	async function copy() {
		const outcome = await copyPlainText(toPlainText(segments));
		if (outcome.kind === "copied") {
			setCopied(true);
			window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
		} else {
			setNotice(outcome.message);
		}
	}

	/**
	 * Segmentation for speech, taken from the same pipeline that renders the
	 * result: a second splitting rule would let the two drift apart.
	 */
	const segmentForSpeech = useCallback(
		(value: string) => segmentTranslation(value).map((entry) => entry.text),
		[],
	);

	/**
	 * Speech is owned here, not inside the buttons: the browser plays one
	 * utterance at a time, so a single controller is what makes "read source" stop
	 * "read target". The buttons below only render it.
	 */
	const speech = useSpeech(segmentForSpeech);

	// Each row excludes its own current value: the label button above it already
	// shows that language, and offering it again reads as a duplicate entry.
	const sourceChips = quickLanguages(store.languageUsage, [
		sourceLang,
		targetLang,
	]);
	const targetChips = quickLanguages(store.languageUsage, [
		targetLang,
		sourceLang,
	]);

	return (
		<div className="flex min-h-screen flex-col">
			{/* Layout: single column on mobile, wider two-column grid from md up.
			    `md:content-start` matters: the container is `flex-1`, so in grid mode it
			    is taller than its content and the rows would otherwise be stretched to
			    absorb the leftover height, opening a large empty band between the
			    toolbar and the language rows. `content-start` packs the rows at their
			    natural height and leaves the slack at the bottom. */}
			<div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:grid md:grid-cols-[1fr_auto_1fr] md:content-start md:gap-x-6 md:gap-y-4 md:p-6">
				<div className="md:col-span-3">
					{/* The toolbar carries only what the workspace needs at a glance.
					    Shortcut hints moved to the footer and a tooltip, and the install
					    entry moved to the header, so this row stays about the task. */}
					<div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
						<button
							type="button"
							className="min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
						>
							文本翻译
						</button>
						{/* One control, two states: an actionable link when nothing is
						    configured, and a plain label once a connection is active. */}
						{active ? (
							<span className="text-muted-foreground text-xs">
								使用中：{active.name}
							</span>
						) : (
							<Link
								to="/settings"
								className="nav-link min-h-11 inline-flex items-center gap-1 text-xs underline"
							>
								未配置连接 — 去设置
							</Link>
						)}
					</div>
				</div>

				{/* Source column */}
				<section className="flex min-h-0 flex-col">
					{/* One row per side: the selected language, then the quick entries, then
					    the "more" entry. Identical structure on both sides keeps the rows
					    aligned; the swap control lives between the columns, not here. */}
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-3 text-xs"
							onClick={() => setPicker("source")}
						>
							{languageChipLabel(
								sourceLang,
								detected !== undefined && sourceLang === AUTO_DETECT,
							)}
						</button>
						{sourceChips.map((code) => (
							<button
								key={code}
								type="button"
								aria-pressed={sourceLang === code}
								className={
									sourceLang === code
										? "min-h-11 rounded-sm border border-primary bg-primary/10 px-3 text-xs"
										: "min-h-11 rounded-sm border border-border px-3 text-xs"
								}
								onClick={() => {
									setSourceLang(code);
									setDetected(undefined);
								}}
							>
								{languageName(code)}
							</button>
						))}
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-3 text-xs"
							onClick={() => setPicker("source")}
						>
							更多 ▾
						</button>
					</div>

					<textarea
						ref={textareaRef}
						id="translation-source"
						name="source-text"
						aria-label="要翻译的文本"
						className="mt-3 min-h-60 flex-1 resize-none rounded-md border border-input bg-background p-4 text-body md:max-h-[calc(100dvh-22rem)] md:min-h-60"
						placeholder="输入要翻译的文本"
						value={text}
						onChange={(event) => {
							const next = acceptInput(event.target.value);
							setText(next.text);
							setNotice(
								next.truncatedFrom === undefined
									? undefined
									: truncationNotice(next.truncatedFrom),
							);
						}}
						onCompositionStart={() => controller.compositionStart()}
						onCompositionEnd={() => {
							controller.compositionEnd();
							setText((current) => current);
						}}
					/>

					{/* This panel's own toolbar: reading aloud belongs to the text it
					    reads, so it sits here rather than in a row shared by both sides.
					    The counter stays on the left, actions on the right. */}
					<div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
						<span
							className={
								state === "normal" ? "text-muted-foreground" : "text-foreground"
							}
						>
							{state === "at-limit"
								? "已达到 5000 字符上限"
								: counterLabel(characters)}
						</span>
						<div className="flex flex-wrap items-center gap-2">
							<SpeechButton
								side="source"
								label="朗读原文"
								binding={speech}
								text={text}
								lang={sourceLang}
							/>
							<SpeechRateControl binding={speech} lang={targetLang} />
							{text !== "" && (
								<button
									type="button"
									className="nav-link min-h-11 text-xs"
									onClick={() => {
										// Clearing also abandons in-flight work and resets the
										// dedupe key, so the same text can be retyped.
										controller.cancel();
										setText("");
										setOutput("");
										setFailure(undefined);
										setNotice(undefined);
										setDetected(undefined);
										textareaRef.current?.focus();
									}}
								>
									清除原文
								</button>
							)}
						</div>
					</div>
				</section>

				{/* The swap axis: a narrow column between the two panes, so the control
				    sits on the midline the two columns share. Desktop only — below the
				    breakpoint the two columns stack and a midline has no meaning. */}
				<div className="hidden md:flex md:flex-col md:items-center md:justify-center">
					<button
						type="button"
						className="min-h-11 min-w-11 rounded-sm border border-border px-2 text-xs disabled:opacity-40"
						disabled={!canSwap(sourceLang)}
						title={
							canSwap(sourceLang)
								? `交换语言（${modifier}+Shift+S）`
								: "检测语言状态下无法交换"
						}
						aria-label="交换源语言与目标语言"
						onClick={swap}
					>
						⇄
					</button>
				</div>

				{/* Target column */}
				<section className="flex min-h-0 flex-col">
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-3 text-xs"
							onClick={() => setPicker("target")}
						>
							{languageChipLabel(targetLang, false)}
						</button>
						{targetChips.map((code) => (
							<button
								key={code}
								type="button"
								aria-pressed={targetLang === code}
								className={
									targetLang === code
										? "min-h-11 rounded-sm border border-primary bg-primary/10 px-3 text-xs"
										: "min-h-11 rounded-sm border border-border px-3 text-xs"
								}
								onClick={() => {
									const resolved = resolveTargetConflict(
										{ source: sourceLang, target: code },
										[sourceLang],
									);
									setTargetLang(code);
									setSourceLang(resolved.pair.source);
									if (resolved.notice) setNotice(resolved.notice);
								}}
							>
								{languageName(code)}
							</button>
						))}
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-3 text-xs"
							onClick={() => setPicker("target")}
						>
							更多 ▾
						</button>
					</div>

					<div className="mt-3 min-h-60 flex-1 overflow-y-auto rounded-md border border-border bg-surface p-4 md:max-h-[calc(100dvh-22rem)] md:min-h-60">
						{pending && output === "" && (
							<p className="text-muted-foreground text-sm">翻译中…</p>
						)}

						{failure !== undefined && (
							<div className="rounded-md border border-border bg-surface p-3 text-sm">
								<p>{failure}</p>
								<button
									type="button"
									className="mt-2 nav-link text-xs"
									onClick={() => controller.retry()}
								>
									重试
								</button>
							</div>
						)}

						{segments.length > 0 && (
							<ol className="space-y-2">
								{segments.map((segment) => (
									<li
										key={segment.index}
										className="rounded-sm min-h-11 px-2 hover:bg-surface"
									>
										{segment.text}
									</li>
								))}
							</ol>
						)}

						{!pending && output === "" && failure === undefined && (
							<p className="text-muted-foreground text-sm">
								译文将显示在这里。
							</p>
						)}
					</div>

					{/* This panel's toolbar: everything that acts on the translation sits
					    with it — read aloud first, then the output actions. Grouping them
					    here is what removed the full-width row that used to separate the
					    panels from their own controls. */}
					<div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
						<SpeechButton
							side="target"
							label="朗读译文"
							binding={speech}
							text={output}
							lang={targetLang}
						/>
						{output !== "" && (
							<>
								<button
									type="button"
									className="nav-link min-h-11 text-xs"
									onClick={copy}
								>
									{copied ? "译文已复制" : "复制译文"}
								</button>
								<button
									type="button"
									className="nav-link min-h-11 text-xs disabled:opacity-40"
									aria-pressed={saved}
									disabled={lastRecordId === undefined}
									title={
										lastRecordId === undefined
											? "本次译文尚未写入历史"
											: undefined
									}
									onClick={() => void toggleSaved()}
								>
									{saved ? "已保存" : "保存翻译"}
								</button>
								<ShareMenu
									sourceLang={sourceLang}
									targetLang={targetLang}
									sourceText={text}
									targetText={output}
								/>
								<SearchLookupButton targetText={output} />
							</>
						)}
					</div>

					{output !== "" && (
						<FeedbackPanel
							key={output}
							sourceText={text}
							targetText={output}
							sourceLang={sourceLang}
							targetLang={targetLang}
						/>
					)}
				</section>
			</div>

			{notice !== undefined && (
				<p className="mx-auto w-full max-w-6xl px-4 pb-4 text-muted-foreground text-xs md:px-6">
					{notice}
				</p>
			)}

			<LanguagePicker
				open={picker !== undefined}
				allowAuto={picker === "source"}
				selected={picker === "source" ? sourceLang : targetLang}
				onSelect={pickLanguage}
				onClose={() => setPicker(undefined)}
			/>
		</div>
	);
}
