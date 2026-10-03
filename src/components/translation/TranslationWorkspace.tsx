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
import {
	attributeFailure,
	type FailureAttribution,
} from "#/lib/connections/attribution";
import type { Connection, ProviderId } from "#/lib/connections/model";
import { createModelCaller } from "#/lib/connections/model-caller";
import { CUSTOM_INSTRUCTION_KEY, STYLE_KEY } from "#/lib/connections/storage";
import { useConnectionStore } from "#/lib/connections/store";
import {
	assemblePrompt,
	isTranslationStyleId,
	TRANSLATION_STYLES,
	type TranslationStyleId,
} from "#/lib/connections/styles";
import {
	type GlossaryMatch,
	getGlossaryVersion,
	matchTerms,
} from "#/lib/glossary";
import {
	DEFAULT_RECORD_LIMIT,
	evictOverLimit,
	openHistoryDatabase,
	setFavorite,
	writeRecord,
} from "#/lib/history/db";
import {
	modeFromUrl,
	urlValueForMode,
	WORKSPACE_MODES,
	type WorkspaceMode,
} from "#/lib/image";
import {
	AUTO_DETECT,
	canSwap,
	DEFAULT_TARGET,
	isTargetLanguage,
	languageByCode,
	languageName,
	quickLanguages,
	resolveTargetConflict,
	swapPair,
} from "#/lib/languages";
import { logger } from "#/lib/logger";
import {
	createTranslationController,
	type TranslationResultMetadata,
} from "#/lib/translation/controller";
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
import { DocumentTranslationMode } from "../document/DocumentTranslationMode";
import { ImageTranslationMode } from "../image/ImageTranslationMode";
import { FeedbackPanel } from "../output/FeedbackPanel";
import { SearchLookupButton } from "../output/SearchLookupButton";
import { ShareMenu } from "../output/ShareMenu";
import {
	SpeechButton,
	SpeechRateControl,
	useSpeech,
} from "../output/SpeechControls";
import {
	LanguagePicker,
	languageChipLabel,
	selectedSourceLanguage,
} from "./LanguagePicker";

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

/** Chip sizes and alignment. */
const CHIP =
	"inline-flex items-center justify-center min-h-11 shrink-0 rounded-sm px-4 text-xs";

/**
 * Quick entries shown below the breakpoint.
 *
 * The full set of three plus the "more" entry wraps at 390px, which breaks the
 * single-row alignment the layout depends on. The third entry stays available
 * through "more", so nothing becomes unreachable.
 */
const MOBILE_CHIP_COUNT = 2;

/**
 * Swap control for stacked layouts.
 *
 * The desktop axis between the columns has no meaning once the panels are stacked,
 * so the control moves into the flow between the source panel and the target
 * language row. Arrows rotate to indicate vertical movement rather than a
 * left-right swap that does not exist in this layout.
 */
function MobileSwapButton({
	canSwap,
	modifier,
	onSwap,
}: {
	readonly canSwap: boolean;
	readonly modifier: string;
	readonly onSwap: () => void;
}) {
	return (
		<div className="flex justify-center md:hidden">
			<button
				type="button"
				className="flex min-h-11 min-w-11 items-center justify-center rounded-sm border border-border px-4 text-xs disabled:opacity-40"
				disabled={!canSwap}
				title={
					canSwap ? `交换语言（${modifier}+Shift+S）` : "检测语言状态下无法交换"
				}
				aria-label="交换源语言与目标语言"
				onClick={onSwap}
			>
				⇅
			</button>
		</div>
	);
}

/**
 * Language chip classes.
 *
 * Every chip is an inline-flex container centered on both axes so text sits
 * vertically centered regardless of platform or screen size. Entries hidden
 * below md omit the base `inline-flex` to avoid overriding `hidden` on mobile.
 *
 * The selected chip fills with the action colour and uses white text — the same
 * pair as a primary button, so "this is the active choice" reads the same way
 * everywhere. A tinted background was not enough: `bg-primary/10` on a white
 * surface is visually near-identical to an unselected chip's plain white.
 */
function chipClass(selected: boolean, mobileHidden = false): string {
	const base = mobileHidden
		? "hidden md:inline-flex items-center justify-center min-h-11 shrink-0 rounded-sm px-4 text-xs"
		: CHIP;
	return selected
		? `${base} border border-transparent bg-primary-strong text-primary-foreground`
		: `${base} border border-border`;
}

/**
 * Prominent link to settings when no model connection is configured.
 *
 * Rendered in both text and image mode toolbars. Styled as a warning button
 * within the design palette, using a glyph and label so state is not conveyed
 * by colour alone.
 */
function UnconfiguredConnectionLink() {
	return (
		<Link
			to="/settings"
			className="inline-flex min-h-11 items-center gap-2 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
		>
			<span aria-hidden="true">⚠</span>
			<span>未配置模型连接 · 去设置</span>
		</Link>
	);
}

export function TranslationWorkspace() {
	const store = useConnectionStore();
	const modifier = useModifierLabel();
	const [sourceLang, setSourceLang] = useState(AUTO_DETECT);
	const [targetLang, setTargetLang] = useState<string>(DEFAULT_TARGET);
	const [text, setText] = useState("");
	const [output, setOutput] = useState("");
	const [pending, setPending] = useState(false);
	const [detected, setDetected] = useState<string | undefined>(undefined);
	const [glossaryMatches, setGlossaryMatches] = useState<
		readonly GlossaryMatch[]
	>([]);
	const [memoryHit, setMemoryHit] = useState(false);
	const [memoryReferenceCount, setMemoryReferenceCount] = useState(0);

	// `detectedRef` mirrors `detected` so the success callback can read the value
	// without re-creating the controller on every detection change.
	useEffect(() => {
		detectedRef.current = detected;
	}, [detected]);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	/**
	 * Workspace mode. Seeded from the URL so a link carrying the image value opens
	 * image mode directly; anything unrecognised resolves to text.
	 */
	const [mode, setMode] = useState<WorkspaceMode>(() =>
		typeof window === "undefined"
			? "text"
			: modeFromUrl(fromQueryString(window.location.search).mode),
	);

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
	 * Created once; the connection state is read through a ref so the tracker
	 * does not need rebuilding when a connection is added. Its identity must stay
	 * stable: callbacks and effects below depend on it.
	 */
	const byokConfigured = useRef(false);
	useEffect(() => {
		byokConfigured.current = store.activeId !== null;
	}, [store.activeId]);
	const analytics = useMemo(
		() => createAnalytics({ byokConfigured: () => byokConfigured.current }),
		[],
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
	//
	// The guard is load-bearing. The effect below mirrors state into the URL, so
	// running this one again reads back the URL of the previous render: with the
	// text changed in between, the two effects then swap the old and new text
	// forever (an infinite render loop from the second typed character on).
	const restoredFromUrl = useRef(false);
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (restoredFromUrl.current) return;
		restoredFromUrl.current = true;
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
		setMode(modeFromUrl(restored.mode));
	}, [reportLanguageChange]);

	// Mirror state into the URL. `writeWorkspaceUrl` uses replaceState only.
	useEffect(() => {
		if (typeof window === "undefined") return;
		writeWorkspaceUrl({
			sourceLang,
			targetLang,
			text,
			mode: urlValueForMode(mode),
		});
	}, [sourceLang, targetLang, text, mode]);

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

	/**
	 * Values the controller callbacks read at call time.
	 *
	 * The controller must live for the whole component lifetime: it owns the
	 * debounce timer, the IME composition flag, the "unchanged input" guard and
	 * the latest-wins slot. Rebuilding it whenever one of these values changed
	 * (the connection store is a new object on every render) dropped all four:
	 * each re-render after a success scheduled another request for the same
	 * text, and the requests multiplied without bound. The callbacks therefore
	 * read the current values through this ref instead of closing over them.
	 */
	const liveValues = {
		active,
		store,
		promptStyle,
		customInstruction,
		sourceLang,
		targetLang,
		analytics,
		reportSubmit,
		persistHistory,
	};
	const live = useRef(liveValues);
	// Declared before the effect that feeds the controller, so a request started
	// from that effect already sees the values of the same render.
	useEffect(() => {
		live.current = liveValues;
	});

	// Created once. Everything that changes over time is read from `live`.
	const controller = useMemo(
		() =>
			createTranslationController({
				glossaryVersion: getGlossaryVersion,
				glossaryMatcher: matchTerms,
				callbacks: {
					onStart: (_requestId, input) => {
						const { reportSubmit } = live.current;
						// Detection belongs to the current input. Clear the previous result
						// before a new request so the chip cannot show stale language data.
						detectedRef.current = undefined;
						setDetected(undefined);
						lastInput.current = {
							text: input.text,
							sourceLang: input.sourceLang,
							targetLang: input.targetLang,
						};
						setPending(true);
						setFailure(undefined);
						setOutput("");
						setGlossaryMatches([]);
						setMemoryHit(false);
						setMemoryReferenceCount(0);

						// The snapshot is also needed for exact memory hits, which do not
						// enter the runner below.
						reportSubmit({
							mode: "text",
							source_lang: input.sourceLang,
							target_lang: input.targetLang,
							input_chars: input.text.length,
							input_kind: "text",
						});
					},
					onChunk: (_id, delta) => setOutput((current) => current + delta),
					onSuccess: (_id, result, _ttftMs, metadata) => {
						const {
							active,
							store,
							sourceLang,
							targetLang,
							analytics,
							persistHistory,
						} = live.current;
						const detectedInput = lastInput.current;
						if (
							detectedInput?.sourceLang === AUTO_DETECT &&
							detectedRef.current === undefined
						) {
							// The current model contract returns translated text only. Keep the
							// existing fallback until a structured detection field is available.
							const detectedLanguage =
								detectedInput.targetLang === "en" ? "zh-Hans" : "en";
							detectedRef.current = detectedLanguage;
							setDetected(detectedLanguage);
						}
						const resolvedMetadata: TranslationResultMetadata = metadata ?? {
							memoryHit: false,
							memoryReferences: [],
							glossaryMatches: [],
						};
						setOutput(result);
						setPending(false);
						setGlossaryMatches(
							resolvedMetadata.glossaryMatches as readonly GlossaryMatch[],
						);
						setMemoryHit(resolvedMetadata.memoryHit);
						setMemoryReferenceCount(resolvedMetadata.memoryReferences.length);
						// Feeds the quick-switch chips with the user's real habits.
						store.noteLanguageUse(lastInput.current?.targetLang ?? targetLang);

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
						const { active, analytics } = live.current;
						// The input is deliberately left untouched, and any previous
						// successful output stays until a new success replaces it.
						setPending(false);
						// A refusal we already attributed carries its own verdict. Re-running
						// the mapping here would overwrite it: this error has no HTTP status
						// and no readable message, so it would be re-classified as the
						// generic combined cause and lose the mixed-content guidance.
						const carried = (
							error as { attribution?: FailureAttribution } | undefined
						)?.attribution;
						const attribution = carried ?? attributeFailure({ error });
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
				run: async ({
					input,
					signal,
					onChunk,
					requestId,
					memoryReferences = [],
					glossaryMatches = [],
				}) => {
					const { active, store, promptStyle, customInstruction } =
						live.current;
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
						glossaryMatches,
						memoryReferences: memoryReferences.map(({ record, score }) => ({
							source: record.sourceText,
							target: record.targetText,
							score,
						})),
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
						if (outcome.refusal.kind === "mixed_content") {
							// Carry the attribution rather than flattening it to a
							// message: the checklist is what makes this actionable, and
							// the same cause must read the same as in the connection test.
							throw Object.assign(
								new Error(outcome.refusal.attribution.summary),
								{
									name: "MixedContentError",
									attribution: outcome.refusal.attribution,
								},
							);
						}
						throw new Error(outcome.refusal.reason);
					}

					logger.debug("translation.run.done", {
						requestId,
						signal: signal.aborted,
					});
					return { text: outcome.text, glossaryMatches };
				},
			}),
		[caller],
	);

	// Abandon pending and in-flight work when the workspace unmounts.
	useEffect(() => () => controller.cancel(), [controller]);

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
		// Re-translate immediately in the new direction. The controller must see
		// the swapped pair now: the state above reaches it only after the render.
		controller.update({
			text,
			sourceLang: next.source,
			targetLang: next.target,
			connectionId: activeId,
			composing: false,
		});
		controller.trigger();
	}, [
		controller,
		text,
		activeId,
		sourceLang,
		targetLang,
		reportLanguageChange,
	]);

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
					detectedRef.current = undefined;
					setSourceLang(AUTO_DETECT);
					setDetected(undefined);
				} else {
					// Keep the user's choice; move the other side if it collides.
					const resolved = resolveTargetConflict(
						{ source: code, target: targetLang },
						[targetLang],
					);
					setSourceLang(code);
					detectedRef.current = undefined;
					setDetected(undefined);
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

	// Keep auto-detect as the request mode, while moving the visual selection to
	// the detected quick chip when that language is visible in the row.
	const selectedSourceLang = selectedSourceLanguage(
		sourceLang,
		detected,
		sourceChips,
	);
	const sourceIsAuto = selectedSourceLang === AUTO_DETECT;

	// Non-text modes are rendered as their own subtree with the same chrome, so the
	// text-mode markup below stays byte-identical and the modes never share state.
	if (mode === "images" || mode === "docs") {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:p-6">
					<div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
						<div
							className="flex items-center gap-2"
							role="toolbar"
							aria-label="翻译模式"
						>
							{WORKSPACE_MODES.map((candidate) => (
								<button
									key={candidate}
									type="button"
									aria-pressed={mode === candidate}
									className={
										mode === candidate
											? "min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
											: "min-h-11 rounded-sm border border-border px-4 text-xs"
									}
									onClick={() => setMode(candidate)}
								>
									{candidate === "text"
										? "文本翻译"
										: candidate === "images"
											? "图片翻译"
											: "文档翻译"}
								</button>
							))}
						</div>
						{active ? (
							<span className="text-muted-foreground text-xs">
								使用中：{active.name}
							</span>
						) : (
							<UnconfiguredConnectionLink />
						)}
					</div>

					{mode === "images" ? (
						<ImageTranslationMode
							connection={active}
							apiKey={active ? store.keyFor(active.id) : ""}
							sourceLang={sourceLang}
							targetLang={targetLang}
							sourceLanguageLabel={languageByCode(sourceLang)?.nameZh}
							targetLanguageLabel={
								languageByCode(targetLang)?.nameZh ?? targetLang
							}
							styleLabel={
								TRANSLATION_STYLES.find((entry) => entry.id === promptStyle)
									?.label
							}
							styleDescription={
								TRANSLATION_STYLES.find((entry) => entry.id === promptStyle)
									?.description
							}
							customInstruction={customInstruction}
							analytics={analytics}
						/>
					) : (
						<DocumentTranslationMode
							connection={active}
							apiKey={active ? store.keyFor(active.id) : ""}
							sourceLang={sourceLang}
							targetLang={targetLang}
							styleId={promptStyle}
							customInstruction={customInstruction}
							analytics={analytics}
						/>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Layout: single column on mobile, a three-column grid (source / swap axis /
			    target) from md up. The toolbar row sizes to content (auto), and the
			    panels take the remaining height (1fr) so they fill the viewport. */}
			<div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:grid md:min-h-0 md:grid-cols-[1fr_auto_1fr] md:grid-rows-[auto_1fr] md:items-stretch md:gap-x-6 md:gap-y-4 md:p-6">
				<div className="md:col-span-3">
					{/* The toolbar carries only what the workspace needs at a glance.
				    Shortcut hints moved to the footer and a tooltip, and the install
				    entry moved to the header, so this row stays about the task. */}
					<div className="flex flex-wrap items-center gap-2 border-b border-border pb-4">
						{/* Mode switch: same workspace, same header, same language pair.
					    No new navigation entry and no new route. */}
						<div
							className="flex items-center gap-2"
							role="toolbar"
							aria-label="翻译模式"
						>
							{WORKSPACE_MODES.map((candidate) => (
								<button
									key={candidate}
									type="button"
									aria-pressed={mode === candidate}
									className={
										mode === candidate
											? "min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
											: "min-h-11 rounded-sm border border-border px-4 text-xs"
									}
									onClick={() => setMode(candidate)}
								>
									{candidate === "text"
										? "文本翻译"
										: candidate === "images"
											? "图片翻译"
											: "文档翻译"}
								</button>
							))}
						</div>
						{/* One control, two states: an actionable link when nothing is
					    configured, and a plain label once a connection is active. */}
						{active ? (
							<span className="text-muted-foreground text-xs">
								使用中：{active.name}
							</span>
						) : (
							<UnconfiguredConnectionLink />
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
							aria-current={sourceIsAuto ? "true" : undefined}
							className={chipClass(sourceIsAuto)}
							onClick={() => setPicker("source")}
						>
							{languageChipLabel(sourceLang, detected)}
						</button>
						{/* Mobile shows one fewer quick entry so the row stays on a single
						    line down to 390px; both entries remain reachable via 更多. */}
						{sourceChips.map((code, index) => (
							<button
								key={code}
								type="button"
								aria-pressed={selectedSourceLang === code}
								aria-current={selectedSourceLang === code ? "true" : undefined}
								className={chipClass(
									selectedSourceLang === code,
									index >= MOBILE_CHIP_COUNT,
								)}
								onClick={() => {
									setSourceLang(code);
									detectedRef.current = undefined;
									setDetected(undefined);
								}}
							>
								{languageName(code)}
							</button>
						))}
						<button
							type="button"
							className={chipClass(false)}
							onClick={() => setPicker("source")}
						>
							更多 ▾
						</button>
					</div>

					{/* Mobile swap: the desktop axis is hidden below the breakpoint, so the
					    control reappears here, centred between this panel and the target
					    language row, with the arrows rotated to read as vertical movement. */}
					<MobileSwapButton
						canSwap={canSwap(sourceLang)}
						modifier={modifier}
						onSwap={swap}
					/>

					<textarea
						ref={textareaRef}
						id="translation-source"
						name="source-text"
						aria-label="要翻译的文本"
						className="mt-4 min-h-60 w-full flex-1 resize-none rounded-md border border-input bg-background p-4 text-body"
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
										detectedRef.current = undefined;
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
							aria-current="true"
							className={chipClass(true)}
							onClick={() => setPicker("target")}
						>
							{languageChipLabel(targetLang)}
						</button>
						{targetChips.map((code, index) => (
							<button
								key={code}
								type="button"
								aria-pressed={targetLang === code}
								aria-current={targetLang === code ? "true" : undefined}
								className={chipClass(
									targetLang === code,
									index >= MOBILE_CHIP_COUNT,
								)}
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
							className={chipClass(false)}
							onClick={() => setPicker("target")}
						>
							更多 ▾
						</button>
					</div>

					<div className="mt-4 min-h-60 flex-1 overflow-y-auto rounded-md border border-border bg-surface p-4">
						{pending && output === "" && (
							<p className="text-muted-foreground text-sm">翻译中…</p>
						)}

						{failure !== undefined && (
							<div className="rounded-md border border-border bg-surface p-4 text-sm">
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

					{output !== "" && (
						<div
							className="mt-2 flex flex-wrap items-start gap-2 text-muted-foreground text-xs"
							aria-live="polite"
						>
							<span>术语命中：{glossaryMatches.length} 条</span>
							{memoryReferenceCount > 0 && (
								<span>参考译文：{memoryReferenceCount} 条</span>
							)}
							{memoryHit && <span>来自翻译记忆</span>}
							{glossaryMatches.length > 0 && (
								<details className="basis-full">
									<summary className="min-h-11 cursor-pointer py-2">
										查看命中术语
									</summary>
									<ul className="space-y-2 border-border border-l-2 pl-4">
										{glossaryMatches.map((match) => (
											<li
												key={`${match.start}-${match.end}-${match.source}-${match.target}`}
											>
												{match.source} → {match.target}
											</li>
										))}
									</ul>
								</details>
							)}
						</div>
					)}

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
								{memoryHit && (
									<button
										type="button"
										className="nav-link min-h-11 text-xs"
										onClick={() => {
											setMemoryHit(false);
											controller.retry({ bypassMemory: true });
										}}
									>
										重新翻译
									</button>
								)}
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
