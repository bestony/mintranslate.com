/**
 * Translation trigger controller.
 *
 * Owns exactly one question: **should a request be sent right now?** The network
 * side is not its concern — `model-caller` already handles capability gating,
 * single-flight, latest-wins cancellation and the per-connection in-flight cap.
 * Keeping the two apart matters because they fail differently: a wrong trigger
 * decision wastes money on requests nobody wanted, while wrong call orchestration
 * double-charges for the same request.
 *
 * The primitives come from `src/lib/call-control` and are not re-implemented
 * here:
 *
 * - `debounce` — 600ms auto-trigger after typing stops, with `cancel`/`flush`;
 * - `throttle` — 400ms leading-only guard on the manual trigger;
 * - `createLatestCall` — a newer request aborts the older one, and the older
 *   one's result is never written back.
 */

import type { BuiltinDetectedLanguage } from "../builtin-ai/translator";
import { debounce } from "../call-control/debounce";
import { createLatestCall } from "../call-control/latest-call";
import { throttle } from "../call-control/throttle";
import { logger, newRequestId, sourceText } from "../logger";
import type {
	GlossaryVersionProvider,
	MemoryContext,
	SimilarMemoryResult,
	TranslationMemoryPort,
} from "../translation-memory";
import {
	getDefaultTranslationMemoryStore,
	readTranslationMemoryEnabled,
} from "../translation-memory";

/** Auto-trigger delay, fixed by the PRD and the upstream downstream contract. */
export const DEBOUNCE_MS = 600;

/** Manual-trigger guard window: leading only, so repeat clicks are dropped. */
export const MANUAL_THROTTLE_MS = 400;

/** Why a trigger did not produce a request. */
export type SuppressionReason =
	| "debouncing"
	| "composing"
	| "unchanged"
	| "empty-input"
	| "no-connection"
	| "throttled";

/** What the controller needs to know about the current input state. */
export interface TranslationInput {
	readonly text: string;
	readonly sourceLang: string;
	readonly targetLang: string;
	/** Identity of the active connection, or `undefined` when none is usable. */
	readonly connectionId: string | undefined;
	/** True while an IME composition is in progress. */
	readonly composing: boolean;
}

/** Outcome of asking the controller to translate. */
export type TriggerOutcome =
	| { readonly kind: "started"; readonly requestId: string }
	| { readonly kind: "suppressed"; readonly reason: SuppressionReason }
	| { readonly kind: "superseded" };

/** What a performed request reports back. */
export interface TranslationRunResult {
	readonly text: string;
	/** Metadata collected while preparing the request. */
	readonly glossaryMatches?: readonly TranslationGlossaryMatch[];
	/** Browser-local source detection, when the active channel performed it. */
	readonly detectedLang?: BuiltinDetectedLanguage;
}

/** Structural glossary data kept here to avoid coupling the controller to UI code. */
export interface TranslationGlossaryMatch {
	readonly source: string;
	readonly target: string;
	readonly index?: number;
	readonly start?: number;
	readonly end?: number;
	readonly priority?: number;
}

/** Optional browser-local matcher used before memory lookup and model work. */
export type GlossaryMatcher = (
	text: string,
	pair: { readonly sl: string; readonly tl: string },
) => Promise<readonly TranslationGlossaryMatch[]>;

/** Metadata sent to the UI only after a request wins latest-wins arbitration. */
export interface TranslationResultMetadata {
	readonly memoryHit: boolean;
	readonly memoryReferences: readonly SimilarMemoryResult[];
	readonly glossaryMatches: readonly TranslationGlossaryMatch[];
	readonly detectedLang?: BuiltinDetectedLanguage;
}

/** Runs one translation. Injected so the controller stays free of provider code. */
export type TranslationRunner = (options: {
	readonly requestId: string;
	readonly input: TranslationInput;
	readonly signal: AbortSignal;
	readonly onChunk: (delta: string) => void;
	readonly memoryHit?: boolean;
	readonly memoryReferences?: readonly SimilarMemoryResult[];
	readonly glossaryMatches?: readonly TranslationGlossaryMatch[];
}) => Promise<TranslationRunResult>;

/** Callbacks the UI supplies. */
export interface ControllerCallbacks {
	readonly onStart: (requestId: string, input: TranslationInput) => void;
	readonly onChunk: (requestId: string, delta: string) => void;
	readonly onSuccess: (
		requestId: string,
		text: string,
		ttftMs: number | undefined,
		metadata?: TranslationResultMetadata,
	) => void;
	readonly onFailure: (requestId: string, error: unknown) => void;
	/** Called when a request was discarded because a newer one replaced it. */
	readonly onSuperseded?: (requestId: string) => void;
}

export interface ControllerDeps {
	readonly run: TranslationRunner;
	readonly callbacks: ControllerCallbacks;
	readonly secrets?: readonly string[];
	/** Injectable clock for deterministic tests. */
	readonly now?: () => number;
	/** Optional memory port. When omitted, the browser-local store is lazy-loaded. */
	readonly memory?: TranslationMemoryPort;
	/** Injectable glossary version provider; defaults to the contract's "none". */
	readonly glossaryVersion?: GlossaryVersionProvider;
	/** Optional matcher; failures degrade to an empty match list. */
	readonly glossaryMatcher?: GlossaryMatcher;
	/** Current prompt style, used as part of the memory key. */
	readonly styleId?: string | (() => string | Promise<string>);
	/** Current model tier, used as part of the memory key. */
	readonly tier?: string | (() => string | Promise<string>);
	/** Memory switch. A provider avoids reading browser storage during render. */
	readonly memoryEnabled?: boolean | (() => boolean | Promise<boolean>);
}

/** The controller surface used by the workspace. */
export interface TranslationController {
	/** Report the current input; schedules an auto-trigger. */
	update(input: TranslationInput): void;
	/** IME composition started. */
	compositionStart(): void;
	/** IME composition ended; the debounce restarts. */
	compositionEnd(): void;
	/** Manual trigger: immediate, guarded against repeat clicks. */
	trigger(): TriggerOutcome;
	/** Retry after a failure, using the last input. */
	retry(options?: { readonly bypassMemory?: boolean }): TriggerOutcome;
	/** Cancel any pending or in-flight work, e.g. the text was cleared. */
	cancel(): void;
	/** The input currently held by the controller. */
	current(): TranslationInput | undefined;
}

/** Keys that identify "the same request" for suppression purposes. */
function inputKey(input: TranslationInput): string {
	return [
		input.text,
		input.sourceLang,
		input.targetLang,
		input.connectionId ?? "",
	].join("\u0000");
}

/** Create a controller. */
export function createTranslationController(
	deps: ControllerDeps,
): TranslationController {
	const { run, callbacks } = deps;
	const secrets = deps.secrets ?? [];
	const now = deps.now ?? (() => Date.now());
	const configuredMemory = deps.memory;

	async function readProvider<T>(
		value: T | (() => T | Promise<T>) | undefined,
		fallback: T,
	): Promise<T> {
		if (value === undefined) return fallback;
		try {
			return typeof value === "function"
				? await (value as () => T | Promise<T>)()
				: value;
		} catch {
			return fallback;
		}
	}

	async function memoryIsEnabled(): Promise<boolean> {
		if (deps.memoryEnabled !== undefined) {
			return readProvider(deps.memoryEnabled, true);
		}
		// `start` is reached from an effect or a user gesture in the application,
		// so this is the first point at which reading localStorage is permitted. Read
		// the persisted value for every request so a settings-page toggle applies to
		// an already-mounted translation workspace without a page reload.
		return readTranslationMemoryEnabled();
	}

	async function memoryPort(): Promise<TranslationMemoryPort | undefined> {
		if (configuredMemory !== undefined) return configuredMemory;
		return getDefaultTranslationMemoryStore();
	}

	async function memoryContext(
		input: TranslationInput,
	): Promise<MemoryContext> {
		let glossaryVersion = "none";
		if (deps.glossaryVersion !== undefined) {
			try {
				glossaryVersion = await deps.glossaryVersion({
					sl: input.sourceLang,
					tl: input.targetLang,
				});
			} catch (error) {
				logger.warn("glossary.version.unavailable", { error });
				glossaryVersion = "none";
			}
		}
		const styleId = await readProvider(deps.styleId, "default");
		const tier = await readProvider(deps.tier, "balanced");
		return {
			sl: input.sourceLang,
			tl: input.targetLang,
			glossaryVersion,
			styleId,
			tier,
		};
	}

	const latest = createLatestCall();
	/** The key of the request most recently *started*, for suppression. */
	let lastStartedKey: string | undefined;
	let currentInput: TranslationInput | undefined;
	/** Set while an IME composition is active. */
	let composing = false;

	/**
	 * Ask for a translation immediately.
	 *
	 * Returns the outcome so the caller can tell "refused because nothing to do"
	 * from "refused because one just ran".
	 */
	function start(
		reason: "auto" | "manual" | "retry",
		options: { readonly bypassMemory?: boolean } = {},
	): TriggerOutcome {
		const input = currentInput;
		if (!input) return { kind: "suppressed", reason: "empty-input" };

		// Ordered from "cheapest to explain to the user" to "already invalid".
		if (input.text.trim() === "") {
			logSuppression("empty-input", undefined, reason);
			return { kind: "suppressed", reason: "empty-input" };
		}

		if (input.connectionId === undefined) {
			logSuppression("no-connection", undefined, reason);
			return { kind: "suppressed", reason: "no-connection" };
		}

		// The same text, direction and connection: a repeat would be a wasted
		// request. Manual retry is exempt, since the user is explicitly asking
		// after a failure.
		const key = inputKey(input);
		if (reason !== "retry" && key === lastStartedKey) {
			logSuppression("unchanged", undefined, reason);
			return { kind: "suppressed", reason: "unchanged" };
		}

		lastStartedKey = key;
		const requestId = newRequestId();
		const startedAt = now();
		const secretsForLog = secrets;

		logger.info(
			"translation.request.start",
			{
				reason,
				sourceLang: input.sourceLang,
				targetLang: input.targetLang,
				text: sourceText(input.text),
				textLength: input.text.length,
			},
			{ requestId, secrets: secretsForLog },
		);

		callbacks.onStart(requestId, input);

		// Fire and track through latest-wins so a newer request aborts this one.
		void latest
			.run(async (signal) => {
				let firstChunkAt: number | undefined;
				let memory: TranslationMemoryPort | undefined;
				let memoryKeyContext: MemoryContext | undefined;
				let memoryHit = false;
				let memoryReferences: readonly SimilarMemoryResult[] = [];
				let glossaryMatches: readonly TranslationGlossaryMatch[] = [];

				if (deps.glossaryMatcher !== undefined) {
					try {
						glossaryMatches = await deps.glossaryMatcher(input.text, {
							sl: input.sourceLang,
							tl: input.targetLang,
						});
						if (signal.aborted) throw new Error("superseded");
						logger.info("glossary.controller.match", {
							count: glossaryMatches.length,
						});
					} catch (error) {
						if (signal.aborted) throw new Error("superseded");
						logger.warn("glossary.controller.match-failed", { error });
						glossaryMatches = [];
					}
				}

				if (!options.bypassMemory && (await memoryIsEnabled())) {
					memory = await memoryPort();
					if (memory !== undefined) {
						memoryKeyContext = await memoryContext(input);
						if (signal.aborted) throw new Error("superseded");
						try {
							const hit = await memory.findTranslation(
								input.text,
								memoryKeyContext,
							);
							if (hit !== undefined && !signal.aborted) {
								memoryHit = true;
								logger.info(
									"translation-memory.controller.hit",
									{ outputLength: hit.length },
									{ requestId, secrets: secretsForLog },
								);
								return {
									result: { text: hit, glossaryMatches },
									firstChunkAt,
									startedAt,
									memory,
									memoryKeyContext,
									memoryHit,
									memoryReferences,
								};
							}
						} catch (error) {
							// A storage failure is a miss. The model remains usable.
							logger.warn(
								"translation-memory.controller.lookup-failed",
								{ error },
								{ requestId, secrets: secretsForLog },
							);
						}

						if (!memoryHit && memory.findSimilar !== undefined) {
							try {
								memoryReferences = await memory.findSimilar(
									input.text,
									{ sl: input.sourceLang, tl: input.targetLang },
									{ threshold: 0.8, limit: 3 },
								);
								if (signal.aborted) throw new Error("superseded");
							} catch (error) {
								if (signal.aborted) throw new Error("superseded");
								logger.warn(
									"translation-memory.controller.similar-failed",
									{ error },
									{ requestId, secrets: secretsForLog },
								);
								memoryReferences = [];
							}
						}
					}
				}

				// A slow memory lookup can finish after a newer request has already
				// replaced this one. Do not fall through and start a model call for the
				// abandoned input; `latest.run` will classify this as superseded.
				if (signal.aborted) throw new Error("superseded");

				const result = await run({
					requestId,
					input,
					signal,
					onChunk: (delta) => {
						if (firstChunkAt === undefined) firstChunkAt = now();
						callbacks.onChunk(requestId, delta);
					},
					memoryHit,
					memoryReferences,
					glossaryMatches,
				});

				return {
					result,
					firstChunkAt,
					startedAt,
					memory,
					memoryKeyContext,
					memoryHit,
					memoryReferences,
				};
			})
			.then((outcome) => {
				if (outcome.kind === "superseded") {
					// The result belongs to an abandoned request: report, never write.
					logger.info(
						"translation.request.superseded",
						{ reason: "superseded" },
						{ requestId, secrets: secretsForLog },
					);
					callbacks.onSuperseded?.(requestId);
					return;
				}

				const {
					result,
					firstChunkAt,
					startedAt: begin,
					memory,
					memoryKeyContext,
					memoryHit,
					memoryReferences,
				} = outcome.value;
				const ttftMs =
					firstChunkAt === undefined ? undefined : firstChunkAt - begin;

				logger.info(
					"translation.request.success",
					{
						durationMs: now() - begin,
						// Time to first token is recorded for diagnosis only; it is not
						// a pass/fail criterion.
						...(ttftMs !== undefined && { ttftMs }),
						outputLength: result.text.length,
					},
					{ requestId, secrets: secretsForLog },
				);

				callbacks.onSuccess(requestId, result.text, ttftMs, {
					memoryHit,
					memoryReferences,
					glossaryMatches: result.glossaryMatches ?? [],
					...(result.detectedLang !== undefined && {
						detectedLang: result.detectedLang,
					}),
				});

				if (
					!memoryHit &&
					memory !== undefined &&
					memoryKeyContext !== undefined
				) {
					void memory
						.writeTranslation(input.text, result.text, memoryKeyContext)
						.then((records) => {
							logger.info(
								"translation-memory.controller.write",
								{ count: records.length, outputLength: result.text.length },
								{ requestId, secrets: secretsForLog },
							);
						})
						.catch((error: unknown) => {
							logger.warn(
								"translation-memory.controller.write-failed",
								{ error },
								{ requestId, secrets: secretsForLog },
							);
						});
				}
			})
			.catch((error: unknown) => {
				logger.error(
					"translation.request.failure",
					{ error, durationMs: now() - startedAt },
					{ requestId, secrets: secretsForLog },
				);
				callbacks.onFailure(requestId, error);
			});

		return { kind: "started", requestId };
	}

	/** Record a suppression with its cause, so "why nothing happened" is answerable. */
	function logSuppression(
		suppressed: SuppressionReason,
		requestId: string | undefined,
		trigger: "auto" | "manual" | "retry",
	): void {
		logger.debug(
			"translation.trigger.suppressed",
			{ suppressed, trigger },
			{ ...(requestId !== undefined && { requestId }), secrets },
		);
	}

	const debouncedAuto = debounce(() => {
		start("auto");
	}, DEBOUNCE_MS);

	/**
	 * Outcome of the most recent manual trigger attempt.
	 *
	 * `throttle` reports nothing back (it is a fire-and-forget guard), so the
	 * callback records whether it actually ran. This keeps the shared primitive
	 * untouched instead of widening its contract for one caller.
	 */
	let lastManualOutcome: TriggerOutcome | undefined;

	const throttledManual = throttle(
		() => {
			lastManualOutcome = start("manual");
		},
		MANUAL_THROTTLE_MS,
		// Leading only: repeat clicks inside the window are dropped, not queued.
		{ leading: true, trailing: false },
	);

	return {
		update(input) {
			currentInput = input;

			// While composing, the text is mid-edit: scheduling a request here would
			// translate a half-typed word. The debounce restarts on compositionend.
			if (composing) {
				debouncedAuto.cancel();
				logSuppression("composing", undefined, "auto");
				return;
			}

			if (input.text.trim() === "") {
				// Clearing the input must also abandon anything in flight, so a late
				// result cannot land on an empty box.
				debouncedAuto.cancel();
				latest.cancel();
				lastStartedKey = undefined;
				return;
			}

			debouncedAuto();
		},

		compositionStart() {
			composing = true;
			debouncedAuto.cancel();
			logSuppression("composing", undefined, "auto");
		},

		compositionEnd() {
			composing = false;
			// Restart the debounce rather than firing immediately: the user may still
			// be typing the next word.
			debouncedAuto();
		},

		trigger() {
			lastManualOutcome = undefined;
			throttledManual();

			// No outcome means the throttle window swallowed the click: the user
			// pressed again before the previous window closed.
			if (lastManualOutcome === undefined) {
				logSuppression("throttled", undefined, "manual");
				return { kind: "suppressed", reason: "throttled" };
			}

			return lastManualOutcome;
		},

		retry(options) {
			return start("retry", options);
		},

		cancel() {
			debouncedAuto.cancel();
			throttledManual.cancel();
			latest.cancel();
			lastStartedKey = undefined;
		},

		current() {
			return currentInput;
		},
	};
}
