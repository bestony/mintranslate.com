/**
 * Translation feedback.
 *
 * Design constraints, all from the spec:
 *
 * - **Local only.** No network, and no field that could identify a user.
 * - **Independent from history.** A separate IndexedDB database, not a new table
 *   in the history database. Two reasons: clearing one must not touch the other,
 *   and adding a store to the history database would require a version bump,
 *   which blocks readers still holding the old version open (the history layer
 *   already reports that condition as "unavailable").
 * - **Self-contained records.** A feedback entry carries its own reviewed text
 *   rather than a history id, so clearing history cannot leave a dangling
 *   reference.
 */

import { logger } from "../logger";

/** Feedback kinds. */
export const FEEDBACK_KINDS = ["good", "bad", "suggestion"] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** A stored feedback entry. */
export interface FeedbackRecord {
	readonly id: string;
	readonly kind: FeedbackKind;
	/** The translation that was reviewed. */
	readonly targetText: string;
	/** The translation read alongside it, when known. */
	readonly sourceText?: string;
	/** Edited replacement text, only for `suggestion`. */
	readonly suggestion?: string;
	readonly sourceLang?: string;
	readonly targetLang?: string;
	readonly createdAt: number;
}

/** Input accepted when recording feedback. */
export interface FeedbackInput {
	readonly kind: FeedbackKind;
	readonly targetText: string;
	readonly sourceText?: string;
	readonly suggestion?: string;
	readonly sourceLang?: string;
	readonly targetLang?: string;
}

export const FEEDBACK_DATABASE_NAME = "mintranslate-feedback";
export const FEEDBACK_DATABASE_VERSION = 1;
export const FEEDBACK_STORE = "feedback";

/** Default cap on retained entries. */
export const DEFAULT_FEEDBACK_LIMIT = 500;

/** Outcome of opening the feedback database. */
export type FeedbackOpenResult =
	| { readonly ok: true; readonly db: IDBDatabase }
	| { readonly ok: false; readonly reason: string };

/** Whether a value is a feedback kind. */
export function isFeedbackKind(value: unknown): value is FeedbackKind {
	return (
		typeof value === "string" &&
		(FEEDBACK_KINDS as readonly string[]).includes(value)
	);
}

/** Wrap a request in a promise. */
function asPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

/** Wrap a transaction's completion. */
function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
	});
}

/**
 * Open the feedback database.
 *
 * A separate database from the history one; see the module comment for why.
 */
export function openFeedbackDatabase(
	factory: IDBFactory | undefined = typeof indexedDB === "undefined"
		? undefined
		: indexedDB,
): Promise<FeedbackOpenResult> {
	if (!factory) {
		return Promise.resolve({ ok: false, reason: "当前浏览器不支持本地存储" });
	}

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = factory.open(FEEDBACK_DATABASE_NAME, FEEDBACK_DATABASE_VERSION);
		} catch (error) {
			resolve({ ok: false, reason: `无法打开本地存储：${String(error)}` });
			return;
		}

		request.onupgradeneeded = () => {
			const database = request.result;
			if (database.objectStoreNames.contains(FEEDBACK_STORE)) return;

			const store = database.createObjectStore(FEEDBACK_STORE, {
				keyPath: "id",
			});
			// Time ordering serves both listing and eviction.
			store.createIndex("by_created", "createdAt", { unique: false });
		};

		request.onsuccess = () => resolve({ ok: true, db: request.result });
		request.onerror = () =>
			resolve({
				ok: false,
				reason: request.error?.message ?? "打开本地存储失败",
			});
		request.onblocked = () =>
			resolve({ ok: false, reason: "本地存储被其他标签页占用" });
	});
}

/** Generate an entry id. */
function newId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Validation outcome for an input. */
export type ValidationOutcome =
	| { readonly ok: true; readonly input: FeedbackInput }
	| { readonly ok: false; readonly reason: string };

/**
 * Validate feedback before storing it.
 *
 * A suggestion must carry actual text: an empty suggestion would be recorded as a
 * feedback entry that tells the user nothing.
 */
export function validateFeedback(raw: unknown): ValidationOutcome {
	if (typeof raw !== "object" || raw === null)
		return { ok: false, reason: "反馈不是对象" };

	const value = raw as Record<string, unknown>;
	if (!isFeedbackKind(value.kind))
		return { ok: false, reason: "未知的反馈类型" };
	if (typeof value.targetText !== "string")
		return { ok: false, reason: "缺少被评价的译文" };

	if (value.kind === "suggestion") {
		if (
			typeof value.suggestion !== "string" ||
			value.suggestion.trim() === ""
		) {
			return { ok: false, reason: "修改建议不能为空" };
		}
	}

	return {
		ok: true,
		input: {
			kind: value.kind,
			targetText: value.targetText,
			...(typeof value.sourceText === "string" && {
				sourceText: value.sourceText,
			}),
			...(typeof value.suggestion === "string" && value.suggestion.trim() !== ""
				? { suggestion: value.suggestion }
				: {}),
			...(typeof value.sourceLang === "string" && {
				sourceLang: value.sourceLang,
			}),
			...(typeof value.targetLang === "string" && {
				targetLang: value.targetLang,
			}),
		},
	};
}

/** Record one feedback entry, then enforce the cap. */
export async function recordFeedback(
	db: IDBDatabase,
	input: FeedbackInput,
	now: number = Date.now(),
	limit: number = DEFAULT_FEEDBACK_LIMIT,
): Promise<
	| { readonly ok: true; readonly record: FeedbackRecord }
	| { readonly ok: false; readonly reason: string }
> {
	const validated = validateFeedback(input);
	if (!validated.ok) return { ok: false, reason: validated.reason };

	const record: FeedbackRecord = {
		id: newId(),
		...validated.input,
		createdAt: now,
	};

	try {
		const transaction = db.transaction(FEEDBACK_STORE, "readwrite");
		transaction.objectStore(FEEDBACK_STORE).put(record);
		await transactionDone(transaction);

		const evicted = await evictOverLimit(db, limit);
		// Metadata only: the reviewed text is user content and stays out of default logs.
		logger.info("feedback.recorded", { kind: record.kind, evicted });

		return { ok: true, record };
	} catch (error) {
		return { ok: false, reason: `记录反馈失败：${String(error)}` };
	}
}

/** Read all entries, oldest first. */
export async function readAllFeedback(
	db: IDBDatabase,
): Promise<FeedbackRecord[]> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(FEEDBACK_STORE, "readonly");
		const index = transaction.objectStore(FEEDBACK_STORE).index("by_created");

		const records: FeedbackRecord[] = [];
		const request = index.openCursor();

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(records);
				return;
			}
			records.push(cursor.value as FeedbackRecord);
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("读取反馈失败"));
	});
}

/** Count entries. */
export async function countFeedback(db: IDBDatabase): Promise<number> {
	const transaction = db.transaction(FEEDBACK_STORE, "readonly");
	return asPromise(
		transaction.objectStore(FEEDBACK_STORE).count() as IDBRequest<number>,
	);
}

/**
 * Evict the oldest entries beyond the cap.
 *
 * The cap keeps the local footprint bounded; export stays available for whatever
 * is retained, so nothing is lost silently without the user having a way out.
 */
export async function evictOverLimit(
	db: IDBDatabase,
	limit: number = DEFAULT_FEEDBACK_LIMIT,
): Promise<number> {
	const records = await readAllFeedback(db);
	if (records.length <= limit) return 0;

	// `readAllFeedback` walks the time index ascending, so the head is the oldest.
	const excess = records.slice(0, records.length - limit);

	const transaction = db.transaction(FEEDBACK_STORE, "readwrite");
	const store = transaction.objectStore(FEEDBACK_STORE);
	for (const record of excess) store.delete(record.id);
	await transactionDone(transaction);

	logger.info("feedback.evicted", { count: excess.length });
	return excess.length;
}

/** Remove every entry. */
export async function clearFeedback(db: IDBDatabase): Promise<boolean> {
	try {
		const transaction = db.transaction(FEEDBACK_STORE, "readwrite");
		transaction.objectStore(FEEDBACK_STORE).clear();
		await transactionDone(transaction);
		logger.warn("feedback.cleared");
		return true;
	} catch {
		return false;
	}
}

/** Export payload version. */
export const FEEDBACK_EXPORT_VERSION = 1;

/**
 * Build the export payload.
 *
 * Field by field rather than a spread, so a field that somehow reached the record
 * cannot be exported by accident. There is no identity field to begin with; this
 * keeps that true regardless of what a future caller passes.
 */
export function buildFeedbackExport(
	records: readonly FeedbackRecord[],
	exportedAt: string,
): {
	readonly version: number;
	readonly exportedAt: string;
	readonly feedback: readonly Record<string, unknown>[];
} {
	return {
		version: FEEDBACK_EXPORT_VERSION,
		exportedAt,
		feedback: records.map((record) => ({
			kind: record.kind,
			targetText: record.targetText,
			...(record.sourceText !== undefined && { sourceText: record.sourceText }),
			...(record.suggestion !== undefined && { suggestion: record.suggestion }),
			...(record.sourceLang !== undefined && { sourceLang: record.sourceLang }),
			...(record.targetLang !== undefined && { targetLang: record.targetLang }),
			createdAt: record.createdAt,
		})),
	};
}

/** Result of preparing an export. */
export type ExportOutcome =
	| { readonly ok: true; readonly payload: string; readonly count: number }
	| { readonly ok: false; readonly reason: string };

/** Prepare the export content, or explain why there is nothing to export. */
export async function exportFeedback(
	db: IDBDatabase,
	exportedAt: string = new Date().toISOString(),
): Promise<ExportOutcome> {
	const records = await readAllFeedback(db);
	// An empty file is not a useful export: say so instead of producing one.
	if (records.length === 0)
		return { ok: false, reason: "没有可导出的反馈记录" };

	logger.info("feedback.exported", { count: records.length });
	return {
		ok: true,
		payload: JSON.stringify(buildFeedbackExport(records, exportedAt), null, 2),
		count: records.length,
	};
}
