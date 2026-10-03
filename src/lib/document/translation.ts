/**
 * Document chunk orchestration.
 *
 * A document run is a collection of independent model calls. The shared
 * connection limiter remains the only concurrency queue; this module adds only
 * document-specific work: prompt construction, memory lookup, progress writes,
 * and result placement. Every log field is metadata, never document text.
 */

import {
	decideRetry,
	isRateLimited,
	parseRetryAfter,
} from "../call-control/backoff";
import {
	type ConcurrencyLimiter,
	createKeyedLimiters,
} from "../call-control/concurrency";
import {
	attributeFailure,
	type FailureAttribution,
} from "../connections/attribution";
import { retryAfterOf, statusOf } from "../connections/error-shape";
import type { Connection } from "../connections/model";
import {
	createModelCaller,
	type ModelCaller,
	type ModelCallRefusal,
	type ModelCallRequest,
	type ModelTransport,
} from "../connections/model-caller";
import {
	assemblePrompt,
	type GlossaryPromptTerm,
	isTranslationStyleId,
} from "../connections/styles";
import { type GlossaryMatch, matchTerms } from "../glossary";
import { logger } from "../logger";
import type {
	MemoryContext,
	TranslationMemoryPort,
} from "../translation-memory";
import type { DocumentTaskRecord, TextChunk } from "./model";
import {
	applyChunkResultAt,
	beginProcessing,
	pendingChunks,
	progressOf,
	transition,
} from "./task";

const defaultLimiters = createKeyedLimiters(2);

export interface DocumentTranslationRequest {
	readonly record: DocumentTaskRecord;
	readonly connection: Connection;
	readonly apiKey: string;
	readonly requestId?: string;
	/** A caller-owned signal; aborting it cancels the whole document run. */
	readonly signal?: AbortSignal;
	readonly customInstruction?: string;
}

export interface DocumentTranslationDeps {
	readonly limiterFor?: (connectionId: string) => ConcurrencyLimiter;
	readonly transport?: ModelTransport;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly maxRateLimitRetries?: number;
	readonly glossaryMatcher?: GlossaryMatcher;
	readonly glossaryVersion?: string;
	readonly memory?: TranslationMemoryPort;
	readonly onUpdate?: (record: DocumentTaskRecord) => Promise<void> | void;
	readonly now?: () => number;
}

export type GlossaryMatcher = (
	text: string,
	pair: { readonly sl: string; readonly tl: string },
) => Promise<readonly GlossaryPromptTerm[]>;

export type DocumentTranslationOutcome =
	| {
			readonly kind: "succeeded";
			readonly record: DocumentTaskRecord;
			readonly memoryHits: number;
			readonly translatedChunks: number;
	  }
	| {
			readonly kind: "failed";
			readonly record: DocumentTaskRecord;
			readonly attribution: FailureAttribution;
			readonly memoryHits: number;
			readonly translatedChunks: number;
	  }
	| {
			readonly kind: "cancelled";
			readonly record: DocumentTaskRecord;
			readonly memoryHits: number;
			readonly translatedChunks: number;
	  };

/** Stable error used to carry a refusal attribution through the worker pool. */
class DocumentTranslationError extends Error {
	readonly attribution?: FailureAttribution;

	constructor(message: string, attribution?: FailureAttribution) {
		super(message);
		this.name = "DocumentTranslationError";
		this.attribution = attribution;
	}
}

class DocumentCancelledError extends Error {
	constructor() {
		super("document translation cancelled");
		this.name = "DocumentCancelledError";
	}
}

class DocumentStoppedError extends Error {
	constructor() {
		super("document translation stopped");
		this.name = "DocumentStoppedError";
	}
}

function isDocumentStoppedError(error: unknown): error is DocumentStoppedError {
	return error instanceof DocumentStoppedError;
}

function refusalError(refusal: ModelCallRefusal): DocumentTranslationError {
	if (refusal.kind === "mixed_content")
		return new DocumentTranslationError("mixed content", refusal.attribution);
	return new DocumentTranslationError(
		refusal.kind === "capability"
			? refusal.reason
			: "model call was superseded",
	);
}

function isRefusedOutcome(
	value: unknown,
): value is { readonly kind: "refused"; readonly refusal: ModelCallRefusal } {
	if (typeof value !== "object" || value === null) return false;
	if (!("kind" in value) || value.kind !== "refused") return false;
	if (!("refusal" in value) || typeof value.refusal !== "object") return false;
	return value.refusal !== null && "kind" in value.refusal;
}

function defaultGlossaryMatcher(
	text: string,
	pair: { readonly sl: string; readonly tl: string },
): Promise<readonly GlossaryMatch[]> {
	return matchTerms(text, pair);
}

function memoryContext(
	record: DocumentTaskRecord,
	version: string,
	connection: Connection,
): MemoryContext {
	return {
		sl: record.sourceLang,
		tl: record.targetLang,
		styleId: record.styleId,
		glossaryVersion: version,
		tier: connection.tier ?? "balanced",
	};
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DocumentCancelledError();
}

/** Wake a queued model call when the document-level cancellation signal fires. */
async function callWithAbort(
	caller: ModelCaller,
	request: ModelCallRequest,
	signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ModelCaller["call"]>>> {
	if (signal === undefined) return caller.call(request);
	if (signal.aborted) throw new DocumentCancelledError();

	let onAbort = () => {};
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(new DocumentCancelledError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([caller.call(request), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function sleepWithAbort(
	milliseconds: number,
	signal: AbortSignal | undefined,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
	abortIfNeeded(signal);
	if (milliseconds <= 0) return;
	if (signal === undefined) {
		await sleep(milliseconds);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (error === undefined) resolve();
			else reject(error);
		};
		const onAbort = () => finish(new DocumentCancelledError());
		signal.addEventListener("abort", onAbort, { once: true });
		void sleep(milliseconds).then(
			() => finish(),
			(error) => finish(error),
		);
	});
}

function chunkKey(chunk: TextChunk): string {
	return chunk.id;
}

function attributionFor(error: unknown): FailureAttribution {
	if (error instanceof DocumentTranslationError && error.attribution)
		return error.attribution;
	return attributeFailure({ httpStatus: statusOf(error), error });
}

/** Translate all unfinished chunks and persist every successful result. */
export async function translateDocument(
	request: DocumentTranslationRequest,
	deps: DocumentTranslationDeps = {},
): Promise<DocumentTranslationOutcome> {
	const now = deps.now ?? (() => Date.now());
	const requestId = request.requestId ?? `doc-${Date.now().toString(36)}`;
	const signal = request.signal;
	const limiterFor =
		deps.limiterFor ?? ((id: string) => defaultLimiters.for(id));
	const suppliedTransport = deps.transport;
	const sleep =
		deps.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const matchGlossary = deps.glossaryMatcher ?? defaultGlossaryMatcher;
	const version = deps.glossaryVersion ?? "none";
	const context = memoryContext(request.record, version, request.connection);
	const callers = new Set<ReturnType<typeof createModelCaller>>();
	let memoryHits = 0;
	let translatedChunks = 0;
	let stopped = false;
	let terminalFailure: unknown;
	let current: DocumentTaskRecord = request.record;
	let saveTail = Promise.resolve();

	const stopForFailure = (error: unknown): void => {
		if (terminalFailure === undefined) terminalFailure = error;
		stopped = true;
	};

	const guardedLimiterFor = (
		connectionId: string,
		attemptsSoFar: () => number,
	): ConcurrencyLimiter => {
		const limiter = limiterFor(connectionId);
		return {
			run: (task, isLatest) =>
				limiter
					.run(async () => {
						if (stopped || (isLatest !== undefined && !isLatest()))
							throw new DocumentStoppedError();
						try {
							const outcome = await task();
							if (isRefusedOutcome(outcome)) {
								if (!(outcome.refusal.kind === "superseded" && signal?.aborted))
									stopForFailure(refusalError(outcome.refusal));
							}
							return outcome;
						} catch (error) {
							if (error instanceof DocumentCancelledError || signal?.aborted)
								throw error;
							const status = statusOf(error);
							if (!isRateLimited(status)) {
								stopForFailure(error);
							} else {
								const decision = decideRetry({
									attemptsSoFar: attemptsSoFar(),
									retryAfter: parseRetryAfter(retryAfterOf(error)),
									...(deps.maxRateLimitRetries !== undefined && {
										policy: { maxRetries: deps.maxRateLimitRetries },
									}),
								});
								if (decision.kind !== "retry") stopForFailure(error);
							}
							throw error;
						}
					}, isLatest)
					.then((slot) => {
						if (slot.kind === "superseded" && !signal?.aborted)
							stopForFailure(
								new DocumentTranslationError("model call was superseded"),
							);
						return slot;
					}),
			active: () => limiter.active(),
			queued: () => limiter.queued(),
		};
	};

	const save = (record: DocumentTaskRecord): Promise<void> => {
		current = record;
		if (deps.onUpdate === undefined) return Promise.resolve();
		const snapshot = record;
		saveTail = saveTail.then(() => deps.onUpdate?.(snapshot));
		return saveTail;
	};

	const cancelCallers = () => {
		stopped = true;
		for (const caller of callers) caller.cancel(request.connection.id);
	};
	const onAbort = () => cancelCallers();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const started =
			current.state === "processing"
				? { ok: true as const, record: current }
				: beginProcessing(current, now());
		if (!started.ok) {
			return {
				kind: "failed",
				record: current,
				attribution: attributeFailure({ error: new Error(started.reason) }),
				memoryHits,
				translatedChunks,
			};
		}
		current = started.record;
		await save(current);

		const pending = pendingChunks(current);
		const chunkIndexById = new Map(
			current.chunks.map((entry, index) => [entry.chunk.id, index] as const),
		);
		if (pending.length === 0) {
			const succeeded = transition(current, "succeeded", { now: now() });
			if (!succeeded.ok) throw new Error(succeeded.reason);
			await save(succeeded.record);
			return {
				kind: "succeeded",
				record: succeeded.record,
				memoryHits,
				translatedChunks,
			};
		}

		const runOne = async (entry: (typeof pending)[number]): Promise<void> => {
			abortIfNeeded(signal);
			if (stopped) return;
			const text = entry.chunk.text;
			let glossaryMatches: readonly GlossaryPromptTerm[] = [];
			try {
				glossaryMatches = await matchGlossary(text, {
					sl: current.sourceLang,
					tl: current.targetLang,
				});
			} catch (error) {
				logger.warn("document.glossary.failed", {
					requestId,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
			abortIfNeeded(signal);
			if (stopped) return;

			if (deps.memory !== undefined) {
				try {
					const remembered = await deps.memory.findTranslation(text, context);
					if (remembered !== undefined) {
						memoryHits += 1;
						const index = chunkIndexById.get(entry.chunk.id);
						if (index === undefined) return;
						current = applyChunkResultAt(current, index, remembered, {
							fromMemory: true,
							now: now(),
						});
						await save(current);
						logger.debug("document.chunk.memory-hit", {
							requestId,
							memoryHits,
						});
						return;
					}
				} catch (error) {
					logger.warn("document.memory.lookup-failed", {
						requestId,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}

			const styleId = isTranslationStyleId(current.styleId)
				? current.styleId
				: "free";
			const prompt = assemblePrompt({
				styleId,
				customInstruction: request.customInstruction,
				text,
				glossaryMatches,
			});
			let rateLimitAttempts = 0;
			for (;;) {
				abortIfNeeded(signal);
				if (stopped) return;
				const caller = createModelCaller({
					limiterFor: (connectionId) =>
						guardedLimiterFor(connectionId, () => rateLimitAttempts),
					transport: suppliedTransport,
				});
				callers.add(caller);
				try {
					const outcome = await callWithAbort(
						caller,
						{
							connection: request.connection,
							apiKey: request.apiKey,
							requirement: "text",
							systemInstruction: prompt.systemInstruction,
							userContent: prompt.userContent,
							dedupeKey: `${requestId}:${chunkKey(entry.chunk)}:${rateLimitAttempts}`,
						},
						signal,
					);
					if (outcome.kind === "refused") {
						if (outcome.refusal.kind === "superseded" && signal?.aborted)
							throw new DocumentCancelledError();
						const error = refusalError(outcome.refusal);
						stopForFailure(error);
						throw error;
					}
					const index = chunkIndexById.get(entry.chunk.id);
					if (index === undefined) return;
					current = applyChunkResultAt(current, index, outcome.text, {
						fromMemory: false,
						now: now(),
					});
					translatedChunks += 1;
					await save(current);
					logger.debug("document.chunk.done", {
						requestId,
						completed: progressOf(current).completed,
						total: current.chunks.length,
						memoryHits,
					});
					return;
				} catch (error) {
					if (error instanceof DocumentCancelledError || signal?.aborted)
						throw new DocumentCancelledError();
					if (isDocumentStoppedError(error)) throw error;
					const status = statusOf(error);
					if (isRateLimited(status)) {
						const decision = decideRetry({
							attemptsSoFar: rateLimitAttempts,
							retryAfter: parseRetryAfter(retryAfterOf(error)),
							...(deps.maxRateLimitRetries !== undefined && {
								policy: { maxRetries: deps.maxRateLimitRetries },
							}),
						});
						logger.debug("document.chunk.rate-limited", {
							requestId,
							attempts: rateLimitAttempts,
							waitMs: decision.waitMs,
							decision: decision.kind,
						});
						if (decision.kind === "retry") {
							rateLimitAttempts += 1;
							await sleepWithAbort(decision.waitMs, signal, sleep);
							continue;
						}
					}
					stopForFailure(error);
					throw error;
				} finally {
					callers.delete(caller);
				}
			}
		};

		const outcomes = await Promise.allSettled(
			pending.map((entry) => runOne(entry)),
		);
		const cancellation = outcomes.find(
			(outcome) =>
				outcome.status === "rejected" &&
				(outcome.reason instanceof DocumentCancelledError || signal?.aborted),
		);
		if (cancellation !== undefined || signal?.aborted) {
			cancelCallers();
			const cancelled = transition(current, "failed", {
				now: now(),
				failureKind: "cancelled",
			});
			if (!cancelled.ok) throw new Error(cancelled.reason);
			await save(cancelled.record);
			return {
				kind: "cancelled",
				record: cancelled.record,
				memoryHits,
				translatedChunks,
			};
		}

		const failed =
			terminalFailure === undefined
				? outcomes.find(
						(outcome) =>
							outcome.status === "rejected" &&
							!isDocumentStoppedError(outcome.reason),
					)
				: { status: "rejected" as const, reason: terminalFailure };
		if (failed?.status === "rejected") {
			cancelCallers();
			const attribution = attributionFor(failed.reason);
			logger.warn("document.translation.failed", {
				requestId,
				status: statusOf(failed.reason),
				completed: progressOf(current).completed,
				total: current.chunks.length,
				memoryHits,
				attribution: attribution.type,
			});
			const failedRecord = transition(current, "failed", {
				now: now(),
				failureKind: "error",
				detail: attribution.summary,
			});
			if (!failedRecord.ok) throw new Error(failedRecord.reason);
			await save(failedRecord.record);
			return {
				kind: "failed",
				record: failedRecord.record,
				attribution,
				memoryHits,
				translatedChunks,
			};
		}

		const succeeded = transition(current, "succeeded", { now: now() });
		if (!succeeded.ok) throw new Error(succeeded.reason);
		await save(succeeded.record);
		logger.info("document.translation.done", {
			requestId,
			completed: progressOf(succeeded.record).completed,
			total: succeeded.record.chunks.length,
			memoryHits,
			translatedChunks,
		});
		return {
			kind: "succeeded",
			record: succeeded.record,
			memoryHits,
			translatedChunks,
		};
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await saveTail;
	}
}

/** Expose the default per-connection limiter for a UI that shares this lane. */
export function documentLimiterFor(connectionId: string): ConcurrencyLimiter {
	return defaultLimiters.for(connectionId);
}
