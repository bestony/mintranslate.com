/**
 * Task state machine and resume rules.
 *
 * Pure functions over a task record, so every transition and the two resume
 * decisions can be tested without storage or a model:
 *
 * - which chunks still need work (a resumed task must not re-translate what is
 *   already done);
 * - whether stored results are still usable (a language or style change makes them
 *   describe a different translation, so they must not be reused);
 * - which chunks memory already covers, so those calls are skipped entirely.
 */

import {
	type DocumentTaskRecord,
	type FailureKind,
	isComplete,
	isTerminal,
	type TaskState,
	type TranslatedChunk,
} from "./model";

/** Explicitly start a queued task or resume a failed task. */
export function beginProcessing(
	record: DocumentTaskRecord,
	now: number,
): TransitionResult {
	if (record.state === "queued") {
		return transition(record, "processing", { now });
	}
	if (record.state === "failed") {
		return {
			ok: true,
			record: {
				...record,
				state: "processing",
				failureKind: undefined,
				failureDetail: undefined,
				updatedAt: now,
			},
		};
	}
	if (record.state === "processing") return { ok: true, record };
	return {
		ok: false,
		reason: `任务已处于终态「${record.state}」，需要新建任务才能重新处理`,
	};
}

/** Transitions that are allowed. Anything else is rejected rather than applied. */
const ALLOWED: Record<TaskState, readonly TaskState[]> = {
	// A queued task starts, or is cancelled before it starts.
	queued: ["processing", "failed"],
	processing: ["succeeded", "failed"],
	// Terminal states do not move; resuming creates work on a new run, not a
	// transition of a finished task.
	succeeded: [],
	failed: [],
};

/** Whether a transition is permitted. */
export function canTransition(from: TaskState, to: TaskState): boolean {
	return ALLOWED[from].includes(to);
}

/** A refused transition, for the caller to log rather than apply. */
export type TransitionResult =
	| { readonly ok: true; readonly record: DocumentTaskRecord }
	| { readonly ok: false; readonly reason: string };

/** Move a task to a new state. */
export function transition(
	record: DocumentTaskRecord,
	to: TaskState,
	options: {
		readonly failureKind?: FailureKind;
		readonly detail?: string;
		readonly now: number;
	},
): TransitionResult {
	if (!canTransition(record.state, to)) {
		return {
			ok: false,
			reason: `任务已处于终态「${record.state}」，不能再变为「${to}」`,
		};
	}

	return {
		ok: true,
		record: {
			...record,
			state: to,
			updatedAt: options.now,
			...(to === "failed" && {
				failureKind: options.failureKind ?? "error",
				...(options.detail !== undefined && { failureDetail: options.detail }),
			}),
		},
	};
}

/** Record a chunk's result. */
export function applyChunkResult(
	record: DocumentTaskRecord,
	chunkId: string,
	target: string,
	options: { readonly fromMemory: boolean; readonly now: number },
): DocumentTaskRecord {
	return {
		...record,
		chunks: record.chunks.map((entry) =>
			entry.chunk.id === chunkId
				? { ...entry, target, fromMemory: options.fromMemory }
				: entry,
		),
		updatedAt: options.now,
	};
}

/** Chunks that still need a model call. */
export function pendingChunks(
	record: DocumentTaskRecord,
): readonly TranslatedChunk[] {
	return record.chunks.filter((entry) => entry.target === undefined);
}

/**
 * Whether stored results may be reused.
 *
 * A changed source language, target language or style means the stored chunks
 * describe a different translation than the one being asked for. Reusing them would
 * silently deliver a mix of two translations, so the task must be reprocessed.
 */
export function resultsAreReusable(
	record: DocumentTaskRecord,
	requested: {
		readonly sourceLang: string;
		readonly targetLang: string;
		readonly styleId: string;
	},
): boolean {
	return (
		record.sourceLang === requested.sourceLang &&
		record.targetLang === requested.targetLang &&
		record.styleId === requested.styleId
	);
}

/** Reset stored results when the requested translation context changes. */
export function resetResultsForContext(
	record: DocumentTaskRecord,
	requested: {
		readonly sourceLang: string;
		readonly targetLang: string;
		readonly styleId: string;
	},
	now: number,
): DocumentTaskRecord {
	if (resultsAreReusable(record, requested)) return record;
	return {
		...record,
		sourceLang: requested.sourceLang,
		targetLang: requested.targetLang,
		styleId: requested.styleId,
		state: "queued",
		failureKind: undefined,
		failureDetail: undefined,
		chunks: record.chunks.map(({ chunk }) => ({ chunk })),
		updatedAt: now,
	};
}

/** Whether every chunk has a result, so the task can be marked successful. */
export function readyToSucceed(record: DocumentTaskRecord): boolean {
	return isComplete(record);
}

/**
 * Whether the source file is still needed.
 *
 * Only until the delivered document has been rebuilt: after that, holding a copy of
 * up to 20MB serves nothing.
 */
export function needsSource(
	record: DocumentTaskRecord,
	options: { readonly rebuilt: boolean },
): boolean {
	return !isTerminal(record.state) || !options.rebuilt;
}

/** A task's progress, for display. */
export function progressOf(record: DocumentTaskRecord): {
	readonly completed: number;
	readonly total: number;
	readonly fromMemory: number;
} {
	return {
		completed: record.chunks.filter((entry) => entry.target !== undefined)
			.length,
		total: record.chunks.length,
		fromMemory: record.chunks.filter((entry) => entry.fromMemory === true)
			.length,
	};
}

/** Whether a failure was a user cancellation, so it is not shown as an error. */
export function wasCancelled(record: DocumentTaskRecord): boolean {
	return record.state === "failed" && record.failureKind === "cancelled";
}
