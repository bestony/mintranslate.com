/**
 * Translation call entry point.
 *
 * This is the single place a caller should use to talk to a model. It composes
 * everything this change established:
 *
 * - the capability guard, so an unsuitable connection is refused **before** a
 *   request is sent;
 * - the per-connection concurrency limiter, so one endpoint is not flooded;
 * - latest-wins cancellation, so a superseded call is aborted and its late
 *   result never returned;
 * - the connection-level single-flight for the same request key.
 *
 * `core-translation` is expected to build "translate as you type" on top of
 * this, adding only its own debounce and composition handling. It must not
 * re-implement concurrency, cancellation or capability checks.
 */

import { chat } from "@tanstack/ai";
import type { BuiltinLanguageModelClient } from "../builtin-ai/language-model";
import {
	type BuiltinDetectedLanguage,
	type BuiltinTranslatorClient,
	createBuiltinTranslatorClient,
} from "../builtin-ai/translator";
import type { ConcurrencyLimiter } from "../call-control/concurrency";
import { createLatestCall } from "../call-control/latest-call";
import { createSingleFlightWithState } from "../call-control/single-flight";
import { logger } from "../logger";
import { createAdapterForConnection } from "./adapters";
import { type FailureAttribution, preflightMixedContent } from "./attribution";
import { type CallRequirement, capabilityBlocker } from "./capability-guard";
import { statusOf } from "./error-shape";
import { type Connection, isBuiltinProvider } from "./model";

/**
 * An image supplied to a call.
 *
 * Deliberately the minimum the provider layer needs, and structurally
 * compatible with the SDK's `ImagePart`, so the public interface does not leak
 * a dependency type into every caller.
 */
export interface ModelImageInput {
	/** Base64-encoded bytes, without a data-URL prefix. */
	readonly base64: string;
	/** MIME type of those bytes, e.g. `image/jpeg`. */
	readonly mimeType: string;
}

/** What a caller supplies for one model call. */
export interface ModelCallRequest {
	readonly connection: Connection;
	readonly apiKey: string;
	/** What the call needs from the connection. */
	readonly requirement: CallRequirement;
	readonly systemInstruction?: string;
	/**
	 * The text to send, or the images to send.
	 *
	 * Arrays are only meaningful with `requirement: "vision"`. A text call keeps
	 * passing a string and produces exactly the message it always did.
	 */
	readonly userContent: string;
	/** Original source text, used by browser-native translators without prompts. */
	readonly rawText?: string;
	/** Internal language codes used by browser-native translation APIs. */
	readonly sourceLanguage?: string;
	readonly targetLanguage?: string;
	/** Structured output constraint used by local multimodal calls. */
	readonly responseConstraint?: unknown;
	/** Images to attach. Present only for multimodal calls. */
	readonly images?: readonly ModelImageInput[];
	/**
	 * Stable key for single-flight deduplication.
	 *
	 * Supplied explicitly by callers whose content is large (image bytes), because
	 * deriving the key from the content would put megabytes into a map key. Callers
	 * that omit it keep the previous content-derived behaviour.
	 */
	readonly dedupeKey?: string;
	/** Stream partial text as it arrives. */
	readonly onChunk?: (text: string) => void;
}

/** Why a call did not produce a result. */
export type ModelCallRefusal =
	| { readonly kind: "capability"; readonly reason: string }
	/**
	 * The request would be blocked by the browser before it left: the page is
	 * secure and the endpoint is not HTTPS.
	 *
	 * Carries the full attribution so the caller reports the same cause and the
	 * same checklist the connection test would (spec `intranet-connectivity`).
	 */
	| {
			readonly kind: "mixed_content";
			readonly attribution: FailureAttribution;
	  }
	/** A newer call for the same connection took over. */
	| { readonly kind: "superseded" };

/** Outcome of a model call. */
export type ModelCallOutcome =
	| {
			readonly kind: "result";
			readonly text: string;
			readonly metadata?: ModelCallResultMetadata;
	  }
	| { readonly kind: "refused"; readonly refusal: ModelCallRefusal };

/** Metadata produced by a browser-native translation call. */
export interface ModelCallResultMetadata {
	readonly detectedLang?: BuiltinDetectedLanguage;
}

/** Call surface exposed to the rest of the application. */
export interface ModelCaller {
	call(request: ModelCallRequest): Promise<ModelCallOutcome>;
	/** Abort the in-flight call for a connection, as a user cancellation. */
	cancel(connectionId: string): void;
	/** Whether a call is in flight for a connection. */
	busy(connectionId: string): boolean;
}

/** Executes one request. Injectable so orchestration is testable without a network. */
export type ModelTransport = (
	request: ModelCallRequest,
	signal: AbortSignal,
) => Promise<string | ModelTransportResult>;

/** Structured result accepted from a browser-native transport. */
export interface ModelTransportResult {
	readonly text: string;
	readonly metadata?: ModelCallResultMetadata;
}

/** What the caller needs from the surrounding application. */
export interface ModelCallerDeps {
	/**
	 * Per-connection limiter lookup. Supplied by the caller so limits are shared
	 * across every component that talks to the same connection.
	 */
	readonly limiterFor: (connectionId: string) => ConcurrencyLimiter;
	/**
	 * Transport used to perform the request. Defaults to the real provider path;
	 * tests substitute it so no request leaves the process.
	 */
	readonly transport?: ModelTransport;
	/** Injectable browser-native translator; never routed through an adapter. */
	readonly builtinTranslator?: BuiltinTranslatorClient;
	/** Injectable browser-native multimodal model; never routed through an adapter. */
	readonly builtinLanguageModel?: BuiltinLanguageModelClient;
}

/** Create the caller. */
export function createModelCaller(deps: ModelCallerDeps): ModelCaller {
	const builtinTranslator =
		deps.builtinTranslator ?? createBuiltinTranslatorClient();
	const builtinLanguageModel = deps.builtinLanguageModel;
	const transport =
		deps.transport ??
		((request: ModelCallRequest, signal: AbortSignal) =>
			performCall(request, signal, builtinTranslator, builtinLanguageModel));
	const latestPerConnection = new Map<
		string,
		ReturnType<typeof createLatestCall>
	>();
	const singleFlight = createSingleFlightWithState<
		string,
		string | ModelTransportResult
	>();

	function latestFor(connectionId: string) {
		const existing = latestPerConnection.get(connectionId);
		if (existing) return existing;

		const created = createLatestCall();
		latestPerConnection.set(connectionId, created);
		return created;
	}

	return {
		async call(request) {
			const { connection } = request;

			logger.info("model.call.start", {
				connectionId: connection.id,
				provider: connection.provider,
				model: connection.model,
				requirement: request.requirement,
				stream: Boolean(request.onChunk),
				textLength: request.userContent.length,
			});

			// Refuse before doing anything else: an unsuitable connection must
			// never produce a request (spec `provider-connections`).
			const blocker = capabilityBlocker(connection, request.requirement);
			if (blocker !== undefined) {
				logger.warn("model.call.refused", {
					connectionId: connection.id,
					reason: "capability",
					detail: blocker,
				});
				return {
					kind: "refused",
					refusal: { kind: "capability", reason: blocker },
				};
			}

			// Refuse a request the browser is certain to block, before the limiter
			// and before any transport work: spending a queue slot and a round trip
			// on a guaranteed refusal would waste both, and the resulting error
			// would be reported as a generic network failure.
			const blocked = preflightMixedContent({
				isSecureContext: globalThis.isSecureContext === true,
				pageUrl: typeof location === "undefined" ? undefined : location.href,
				endpoint: connection.endpoint,
			});
			if (blocked !== undefined) {
				logger.warn("model.call.refused", {
					connectionId: connection.id,
					reason: "mixed_content",
					attribution: blocked.type,
				});
				return {
					kind: "refused",
					refusal: { kind: "mixed_content", attribution: blocked },
				};
			}

			const latest = latestFor(connection.id);

			// The flight key includes content, so two different texts are two
			// different requests while genuinely identical ones share a flight.
			// The explicit key wins when supplied. Deriving it from content would
			// hold the image bytes in the key itself.
			const flightKey = `${connection.id}:${request.requirement}:${
				request.dedupeKey ?? request.userContent
			}`;

			// Identical request already in flight: join it instead of superseding
			// it. Superseding would cancel a call that would have produced exactly
			// the same answer, turning a harmless duplicate into a wasted request.
			if (singleFlight.has(flightKey)) {
				logger.debug("model.call.joined_single_flight", {
					connectionId: connection.id,
					requirement: request.requirement,
				});
				const joined = await singleFlight.run(flightKey, () =>
					transport(request, new AbortController().signal),
				);
				return resultFromTransport(joined);
			}

			const outcome = await latest.run(async (signal) =>
				deps.limiterFor(connection.id).run(
					() => singleFlight.run(flightKey, () => transport(request, signal)),
					// Consulted when a slot is granted, so a queued call that was
					// superseded never sends a request.
					() => latest.busy(),
				),
			);

			if (outcome.kind === "superseded") {
				logger.debug("model.call.refused", {
					connectionId: connection.id,
					reason: "superseded",
				});
				return { kind: "refused", refusal: { kind: "superseded" } };
			}

			const slot = outcome.value;
			if (slot.kind === "superseded") {
				logger.debug("model.call.refused", {
					connectionId: connection.id,
					reason: "superseded",
				});
				return { kind: "refused", refusal: { kind: "superseded" } };
			}

			logger.info("model.call.success", {
				connectionId: connection.id,
				provider: connection.provider,
				model: connection.model,
				resultLength:
					typeof slot.value === "string"
						? slot.value.length
						: slot.value.text.length,
			});

			return resultFromTransport(slot.value);
		},

		cancel(connectionId) {
			latestPerConnection.get(connectionId)?.cancel();
		},

		busy(connectionId) {
			return latestPerConnection.get(connectionId)?.busy() ?? false;
		},
	};
}

/** Execute one request, aborting with the provided signal. */
async function performCall(
	request: ModelCallRequest,
	signal: AbortSignal,
	builtinTranslator: BuiltinTranslatorClient,
	builtinLanguageModel?: BuiltinLanguageModelClient,
): Promise<string | ModelTransportResult> {
	const startedAt = Date.now();
	try {
		if (request.connection.provider === "builtin-translator") {
			if (
				request.sourceLanguage === undefined ||
				request.targetLanguage === undefined
			) {
				throw new Error("内置翻译需要源语言和目标语言。");
			}
			const input = request.rawText ?? request.userContent;
			const result = request.onChunk
				? await builtinTranslator.translateStreaming(
						request.sourceLanguage,
						request.targetLanguage,
						input,
						{ signal, onChunk: request.onChunk },
					)
				: await builtinTranslator.translate(
						request.sourceLanguage,
						request.targetLanguage,
						input,
						{ signal },
					);
			return {
				text: result.text,
				...(result.detectedLang !== undefined && {
					metadata: { detectedLang: result.detectedLang },
				}),
			};
		}

		if (isBuiltinProvider(request.connection.provider)) {
			if (request.connection.provider !== "builtin-multimodal")
				throw new Error("未知的内置连接类型。");
			if (builtinLanguageModel === undefined)
				throw new Error("内置多模态模型未初始化。");
			const input = {
				text: request.userContent,
				...(request.images !== undefined && { images: request.images }),
			};
			const text = request.onChunk
				? await builtinLanguageModel.promptStreaming(input, {
						signal,
						responseConstraint: request.responseConstraint,
						targetLanguage: request.targetLanguage,
						systemInstruction: request.systemInstruction,
					})
				: await builtinLanguageModel.prompt(input, {
						signal,
						responseConstraint: request.responseConstraint,
						targetLanguage: request.targetLanguage,
						systemInstruction: request.systemInstruction,
					});
			return { text };
		}

		const adapter = await createAdapterForConnection(
			request.connection,
			request.apiKey,
		);

		/** A multimodal content part, in the shape the provider layer expects. */
		type Part =
			| { type: "text"; text: string }
			| {
					type: "image";
					source: { type: "data"; value: string; mimeType: string };
			  };

		/**
		 * User-side content.
		 *
		 * With no images this stays the plain string it has always been, so the text
		 * path's message is unchanged. Images switch it to the part array the
		 * multimodal providers require, text first so the instruction precedes the
		 * picture it refers to.
		 */
		const userContent: string | Part[] =
			request.images === undefined || request.images.length === 0
				? request.userContent
				: [
						{ type: "text" as const, text: request.userContent },
						...request.images.map((image) => ({
							type: "image" as const,
							source: {
								type: "data" as const,
								value: image.base64,
								mimeType: image.mimeType,
							},
						})),
					];

		const messages: Array<{
			role: "system" | "user";
			content: string | Part[];
		}> = [];
		if (
			request.systemInstruction !== undefined &&
			request.systemInstruction !== ""
		) {
			messages.push({ role: "system", content: request.systemInstruction });
		}
		messages.push({ role: "user", content: userContent });

		if (request.onChunk) {
			const stream = chat({
				adapter,
				messages,
				abortController: createAbortControllerFrom(signal),
			} as Parameters<typeof chat>[0]);

			let collected = "";
			for await (const event of stream as AsyncIterable<{
				type?: string;
				delta?: string;
			}>) {
				const delta = event?.delta;
				if (typeof delta === "string" && delta !== "") {
					collected += delta;
					request.onChunk(delta);
				}
			}
			return collected;
		}

		const text = await chat({
			adapter,
			messages,
			stream: false,
			abortController: createAbortControllerFrom(signal),
		} as Parameters<typeof chat>[0]);

		return typeof text === "string" ? text : "";
	} catch (error) {
		const fields = {
			connectionId: request.connection.id,
			provider: request.connection.provider,
			model: request.connection.model,
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
			status: statusOf(error),
		};
		if (signal.aborted) {
			logger.debug("model.call.aborted", fields, { secrets: [request.apiKey] });
		} else {
			logger.error("model.call.failed", fields, { secrets: [request.apiKey] });
		}
		throw error;
	}
}

/** Normalize legacy string transports and structured built-in results. */
function resultFromTransport(value: string | ModelTransportResult): {
	kind: "result";
	text: string;
	metadata?: ModelCallResultMetadata;
} {
	if (typeof value === "string") return { kind: "result", text: value };
	return {
		kind: "result",
		text: value.text,
		...(value.metadata !== undefined && { metadata: value.metadata }),
	};
}

/**
 * Adapt an `AbortSignal` to the `AbortController` the AI layer expects.
 *
 * The API takes a controller rather than a signal, so an already-aborted signal
 * must be replayed onto the new controller — otherwise the abort would be lost.
 */
function createAbortControllerFrom(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort();
	else
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	return controller;
}
