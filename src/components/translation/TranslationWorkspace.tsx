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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createKeyedLimiters } from "#/lib/call-control/concurrency";
import { attributeFailure } from "#/lib/connections/attribution";
import type { Connection } from "#/lib/connections/model";
import { createModelCaller } from "#/lib/connections/model-caller";
import { CUSTOM_INSTRUCTION_KEY, STYLE_KEY } from "#/lib/connections/storage";
import { useConnectionStore } from "#/lib/connections/store";
import {
	assemblePrompt,
	isTranslationStyleId,
	type TranslationStyleId,
} from "#/lib/connections/styles";
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
import { LanguagePicker, languageChipLabel } from "./LanguagePicker";

/** How the modifier key is shown for the current platform. */
function modifierLabel(): string {
	if (typeof navigator === "undefined") return "Ctrl";
	return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
		? "⌘"
		: "Ctrl";
}

/** One connection's limiter set, shared across the component's lifetime. */
const limiters = createKeyedLimiters(2);

export function TranslationWorkspace() {
	const store = useConnectionStore();
	const [sourceLang, setSourceLang] = useState(AUTO_DETECT);
	const [targetLang, setTargetLang] = useState<string>(DEFAULT_TARGET);
	const [text, setText] = useState("");
	const [output, setOutput] = useState("");
	const [pending, setPending] = useState(false);
	const [detected, setDetected] = useState<string | undefined>(undefined);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const [picker, setPicker] = useState<"source" | "target" | undefined>(
		undefined,
	);
	const [copied, setCopied] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	/** Prompt style and custom instruction, as configured in settings. */
	const [promptStyle, setPromptStyle] = useState<TranslationStyleId>("free");
	const [customInstruction, setCustomInstruction] = useState("");

	const active: Connection | undefined = store.activeConnection;
	const activeId = active?.id;

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
		if (restored.sourceLang !== undefined) setSourceLang(restored.sourceLang);
		if (
			restored.targetLang !== undefined &&
			isTargetLanguage(restored.targetLang)
		) {
			setTargetLang(restored.targetLang);
		}
		if (restored.text !== undefined) setText(restored.text);
	}, []);

	// Mirror state into the URL. `writeWorkspaceUrl` uses replaceState only.
	useEffect(() => {
		if (typeof window === "undefined") return;
		writeWorkspaceUrl({ sourceLang, targetLang, text, mode: "translate" });
	}, [sourceLang, targetLang, text]);

	const controller = useMemo(
		() =>
			createTranslationController({
				callbacks: {
					onStart: () => {
						setPending(true);
						setFailure(undefined);
						setOutput("");
					},
					onChunk: (_id, delta) => setOutput((current) => current + delta),
					onSuccess: (_id, result) => {
						setOutput(result);
						setPending(false);
						// Feeds the quick-switch chips with the user's real habits.
						store.noteLanguageUse(targetLang);
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
					},
					onSuperseded: () => {
						// A newer request is already in flight; it owns the pending flag.
					},
				},
				run: async ({ input, signal, onChunk, requestId }) => {
					if (!active) throw new Error("no active connection");

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
	const modifier = useMemo(modifierLabel, []);

	const swap = useCallback(() => {
		if (!canSwap(sourceLang)) return;
		const next = swapPair({ source: sourceLang, target: targetLang });
		setSourceLang(next.source);
		setTargetLang(next.target);
		// Re-translate immediately in the new direction.
		controller.trigger();
	}, [controller, sourceLang, targetLang]);

	const pickLanguage = useCallback(
		(code: string) => {
			if (picker === "source") {
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
		[picker, sourceLang, targetLang],
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

	async function copy() {
		const outcome = await copyPlainText(toPlainText(segments));
		if (outcome.kind === "copied") {
			setCopied(true);
			window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
		} else {
			setNotice(outcome.message);
		}
	}

	const sourceChips = quickLanguages(store.languageUsage, [targetLang]);
	const targetChips = quickLanguages(store.languageUsage, [sourceLang]);

	return (
		<div className="flex min-h-screen flex-col">
			{/* Layout: single column on mobile, wider two-column grid from md up. */}
			<div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 p-4 md:grid md:grid-cols-2 md:gap-6 md:p-6">
				<div className="md:col-span-2">
					{/* Mobile turns this row into labeled tabs; on desktop it is a toolbar. */}
					<div className="flex flex-wrap items-center gap-2 border-line border-b pb-3">
						<button
							type="button"
							className="rounded-full border border-primary bg-primary px-3 py-1 text-primary-foreground text-xs"
						>
							文本翻译
						</button>
						<span className="text-muted-foreground text-xs">
							{active ? `使用中：${active.name}` : "未配置连接"}
						</span>
						<span className="ml-auto text-muted-foreground text-xs">
							{modifier}+Enter 立即翻译 · {modifier}+Shift+S 交换语言
						</span>
					</div>
				</div>

				{/* Source column */}
				<section className="flex min-h-0 flex-col">
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="rounded-full border border-input px-3 py-1 text-xs"
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
										? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs"
										: "rounded-full border border-input px-3 py-1 text-xs"
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
							className="rounded-full border border-input px-3 py-1 text-xs disabled:opacity-40"
							disabled={!canSwap(sourceLang)}
							title={
								canSwap(sourceLang) ? "交换语言" : "检测语言状态下无法交换"
							}
							onClick={swap}
						>
							⇄ 交换
						</button>
					</div>

					<textarea
						ref={textareaRef}
						className="mt-3 min-h-40 flex-1 resize-none rounded-xl border border-input bg-background p-4 text-base outline-none focus-visible:border-ring md:min-h-64"
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

					<div className="mt-2 flex items-center justify-between text-xs">
						<span
							className={
								state === "normal" ? "text-muted-foreground" : "text-amber-600"
							}
						>
							{state === "at-limit"
								? "已达到 5000 字符上限"
								: counterLabel(characters)}
						</span>
						{text !== "" && (
							<button
								type="button"
								className="nav-link"
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
				</section>

				{/* Target column */}
				<section className="flex min-h-0 flex-col">
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="rounded-full border border-input px-3 py-1 text-xs"
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
										? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs"
										: "rounded-full border border-input px-3 py-1 text-xs"
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
						{output !== "" && (
							<button
								type="button"
								className="ml-auto nav-link text-xs"
								onClick={copy}
							>
								{copied ? "译文已复制" : "复制译文"}
							</button>
						)}
					</div>

					<div className="mt-3 min-h-40 flex-1 overflow-y-auto rounded-xl border border-line bg-surface/60 p-4 md:min-h-64">
						{pending && output === "" && (
							<p className="text-muted-foreground text-sm">翻译中…</p>
						)}

						{failure !== undefined && (
							<div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
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
										className="rounded-md px-2 py-1 hover:bg-accent/60"
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
				</section>
			</div>

			{notice !== undefined && (
				<p className="mx-auto w-full max-w-6xl px-4 pb-4 text-xs text-amber-600 md:px-6">
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
