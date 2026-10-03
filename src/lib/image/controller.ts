/**
 * Image translation orchestration.
 *
 * Wires one image through: prompt assembly → multimodal call → structured parse →
 * one retry on unparseable output → degradation. Everything it needs already
 * exists, and this module deliberately adds no new pacing of its own:
 *
 * - **concurrency, single-flight, latest-wins** come from `model-caller`;
 * - **429 backoff** comes from `call-control/backoff`;
 * - **capability refusal** comes from `capability-guard`, via the caller.
 *
 * Two retry budgets are tracked separately and that is intentional: a parse
 * failure and a rate limit are different problems, and sharing one counter would
 * let either one consume the other's allowance.
 */

import type { BuiltinReadiness } from "../builtin-ai/capability";
import { promptLanguageBlocker } from "../builtin-ai/capability";
import {
	type BuiltinLanguageModelClient,
	BuiltinLanguageModelNotReadyError,
} from "../builtin-ai/language-model";
import {
	decideRetry,
	isRateLimited,
	parseRetryAfter,
} from "../call-control/backoff";
import type { ConcurrencyLimiter } from "../call-control/concurrency";
import type { FailureAttribution } from "../connections/attribution";
import { attributeFailure } from "../connections/attribution";
import { retryAfterOf, statusOf } from "../connections/error-shape";
import type { Connection } from "../connections/model";
import { createModelCaller } from "../connections/model-caller";
import type { GlossaryPromptTerm } from "../connections/styles";
import { logger } from "../logger";
import type { ImageRegion } from "./model";
import { parseRegions } from "./parse";
import { assembleImagePrompt, IMAGE_RESPONSE_CONSTRAINT } from "./prompt";

/** What a caller supplies for one image translation. */
export interface ImageTranslationRequest {
	readonly connection: Connection;
	readonly apiKey: string;
	/** Base64 of the processed image, no data-URL prefix. */
	readonly imageBase64: string;
	readonly imageMimeType: string;
	/**
	 * Stable key for single-flight, derived from the processed bytes.
	 *
	 * Passed explicitly because the caller's own content is megabytes.
	 */
	readonly imageKey: string;
	readonly targetLanguageLabel: string;
	/** Internal language codes, required for the built-in multimodal preflight. */
	readonly sourceLanguage?: string;
	readonly targetLanguage?: string;
	readonly sourceLanguageLabel?: string;
	readonly styleLabel?: string;
	readonly styleDescription?: string;
	readonly customInstruction?: string;
	readonly glossaryMatches?: readonly GlossaryPromptTerm[];
	/** Identifier tying this run's log lines together. */
	readonly requestId: string;
}

/** Outcome of an image translation. */
export type ImageTranslationOutcome =
	| {
			readonly kind: "result";
			readonly regions: readonly ImageRegion[];
			/** Set when structured parsing failed twice and raw text is shown. */
			readonly rawText?: string;
	  }
	| { readonly kind: "refused"; readonly kindReason: string }
	| {
			readonly kind: "failed";
			readonly attribution: FailureAttribution;
			/** Readiness is kept so the UI can offer explicit model activation. */
			readonly builtinReadiness?: BuiltinReadiness;
			readonly targetLanguage?: string;
	  };

/** What the orchestration needs from the surrounding application. */
export interface ImageTranslationDeps {
	readonly limiterFor: (connectionId: string) => ConcurrencyLimiter;
	/** Main-thread Prompt API client for the built-in multimodal provider. */
	readonly builtinLanguageModel?: BuiltinLanguageModelClient;
	/** Sleep, injectable so backoff does not slow tests. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Retry budget policy override, for tests. */
	readonly maxRateLimitRetries?: number;
}

/** How many times an unparseable result is retried. One, per the spec. */
const PARSE_RETRY_LIMIT = 1;

/** The image translation surface. */
export interface ImageTranslator {
	translate(request: ImageTranslationRequest): Promise<ImageTranslationOutcome>;
	/** Abort the in-flight call for a connection. */
	cancel(connectionId: string): void;
}

/** Create a translator. */
export function createImageTranslator(
	deps: ImageTranslationDeps,
): ImageTranslator {
	const caller = createModelCaller({
		limiterFor: deps.limiterFor,
		builtinLanguageModel: deps.builtinLanguageModel,
	});
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

	return {
		async translate(request) {
			if (
				request.connection.provider === "builtin-multimodal" &&
				request.targetLanguage !== undefined
			) {
				const blocker = promptLanguageBlocker(
					request.targetLanguage,
					request.sourceLanguage,
				);
				if (blocker !== undefined) {
					logger.debug("image.run.language-refused", {
						requestId: request.requestId,
					});
					return { kind: "refused", kindReason: blocker };
				}
			}
			const prompt = assembleImagePrompt({
				styleLabel: request.styleLabel,
				styleDescription: request.styleDescription,
				customInstruction: request.customInstruction,
				glossaryMatches: request.glossaryMatches,
				targetLanguageLabel: request.targetLanguageLabel,
				sourceLanguageLabel: request.sourceLanguageLabel,
			});

			let parseAttempt = 0;
			let rateLimitAttempts = 0;

			// Loop rather than recurse so both budgets stay visible in one place.
			for (;;) {
				let text: string;

				try {
					const outcome = await caller.call({
						connection: request.connection,
						apiKey: request.apiKey,
						requirement: "vision",
						systemInstruction: prompt.systemInstruction,
						userContent: prompt.userContent,
						sourceLanguage: request.sourceLanguage,
						targetLanguage: request.targetLanguage,
						responseConstraint:
							request.connection.provider === "builtin-multimodal"
								? IMAGE_RESPONSE_CONSTRAINT
								: undefined,
						images: [
							{ base64: request.imageBase64, mimeType: request.imageMimeType },
						],
						// The first attempt and the parse retry are different flights on
						// purpose: reusing the key would make the retry join the finished
						// call instead of issuing a fresh one.
						dedupeKey: `${request.imageKey}:parse${parseAttempt}`,
					});

					if (outcome.kind === "refused") {
						if (outcome.refusal.kind === "superseded") {
							logger.debug("image.run.superseded", {
								requestId: request.requestId,
							});
							return { kind: "refused", kindReason: "superseded" };
						}
						if (outcome.refusal.kind === "mixed_content") {
							return {
								kind: "failed",
								attribution: outcome.refusal.attribution,
							};
						}
						logger.debug("image.run.capability-refused", {
							requestId: request.requestId,
						});
						return { kind: "refused", kindReason: outcome.refusal.reason };
					}

					text = outcome.text;
				} catch (error) {
					if (error instanceof BuiltinLanguageModelNotReadyError) {
						logger.debug("image.run.model-not-ready", {
							requestId: request.requestId,
							readiness: error.readiness.state,
						});
						return {
							kind: "failed",
							attribution: attributeFailure({ error }),
							builtinReadiness: error.readiness,
							targetLanguage: error.targetLanguage ?? request.targetLanguage,
						};
					}
					// The transport rejects on HTTP failure rather than returning one, so
					// a rate limit arrives here and not as a response body.
					const status = statusOf(error);

					if (isRateLimited(status)) {
						const decision = decideRetry({
							attemptsSoFar: rateLimitAttempts,
							retryAfter: parseRetryAfter(retryAfterOf(error)),
							...(deps.maxRateLimitRetries !== undefined && {
								policy: { maxRetries: deps.maxRateLimitRetries },
							}),
						});

						logger.debug("image.run.rate-limited", {
							requestId: request.requestId,
							rateLimitAttempts,
							waitMs: decision.waitMs,
							decision: decision.kind,
						});

						if (decision.kind === "retry") {
							// Its own budget: a rate limit must not consume the parse retry,
							// and vice versa.
							rateLimitAttempts += 1;
							await sleep(decision.waitMs);
							continue;
						}
					}

					logger.warn("image.run.failed", {
						requestId: request.requestId,
						status,
					});
					return {
						kind: "failed",
						attribution: attributeFailure({ httpStatus: status, error }),
					};
				}

				const parsed = parseRegions(text);

				if (parsed.ok) {
					logger.debug("image.run.done", {
						requestId: request.requestId,
						regions: parsed.regions.length,
						parseAttempt,
						rateLimitAttempts,
					});
					return { kind: "result", regions: parsed.regions };
				}

				// Unreadable output: retry once, then degrade to the raw text. The raw
				// text is returned rather than discarded, so the user sees what the
				// model actually said instead of an empty result.
				if (parseAttempt >= PARSE_RETRY_LIMIT) {
					logger.warn("image.run.parse-degraded", {
						requestId: request.requestId,
						parseAttempt,
						reason: parsed.reason,
						textLength: text.length,
					});
					return { kind: "result", regions: [], rawText: text };
				}

				parseAttempt += 1;
				logger.debug("image.run.parse-retry", {
					requestId: request.requestId,
					parseAttempt,
					reason: parsed.reason,
				});
			}
		},

		cancel(connectionId) {
			caller.cancel(connectionId);
		},
	};
}

/** Retry budgets, exposed for diagnostics and tests. */
export const IMAGE_RETRY_LIMITS = { parseRetryLimit: PARSE_RETRY_LIMIT };
