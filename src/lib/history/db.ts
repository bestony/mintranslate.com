/**
 * IndexedDB wrapper for the history store.
 *
 * A thin layer over the native API: it promises the requests, owns the schema
 * and version migrations, and exposes exactly the operations this feature needs.
 * No general-purpose database abstraction — one table with four indexes does not
 * justify a dependency (design.md D1).
 *
 * Indexes exist to serve the queries that would otherwise scan everything:
 *
 * - `by_updated`   — time-ordered pagination, range filters, eviction order
 * - `by_dedupe`    — point lookup for deduplication (unique, so a duplicate
 *                    *cannot* be inserted even if a caller tries)
 * - `by_langpair`  — language-pair filter
 * - `by_favorite`  — favourites-only filter
 *
 * Keyword search deliberately does **not** get an index: it uses the
 * `by_updated` cursor with early termination (design.md D4).
 *
 * Failure to open the database is reported as an explicit "unavailable" state
 * rather than thrown at callers: private-mode and locked-down intranet browsers
 * reject IndexedDB, and translation must keep working regardless.
 */

import { logger } from "../logger";
import {
	dedupeKey,
	type HistoryRecord,
	type HistoryRecordInput,
	toExportable,
	validateRecord,
} from "./model";

export const DATABASE_NAME = "mintranslate-history";
export const DATABASE_VERSION = 1;
export const RECORDS_STORE = "records";

/** Default cap on retained non-favourite records. */
export const DEFAULT_RECORD_LIMIT = 1000;

/** Index names, referenced by query code so a typo is a compile error. */
export const INDEX_UPDATED = "by_updated";
export const INDEX_DEDUPE = "by_dedupe";
export const INDEX_LANGPAIR = "by_langpair";
export const INDEX_FAVORITE = "by_favorite";

/** Outcome of opening the database. */
export type OpenResult =
	| { readonly ok: true; readonly db: IDBDatabase }
	| { readonly ok: false; readonly reason: string };

/** Filter conditions a query may combine. */
export interface HistoryFilter {
	readonly keyword?: string;
	readonly sourceLang?: string;
	readonly targetLang?: string;
	/** Inclusive lower bound on `updatedAt`. */
	readonly since?: number;
	/** Inclusive upper bound on `updatedAt`. */
	readonly until?: number;
	readonly favoritesOnly?: boolean;
}

/** A page of records plus whether more remain. */
export interface HistoryPage {
	readonly records: readonly HistoryRecord[];
	readonly hasMore: boolean;
}

/** Result of a write. */
export type WriteResult =
	| {
			readonly ok: true;
			readonly record: HistoryRecord;
			readonly inserted: boolean;
	  }
	| { readonly ok: false; readonly reason: string };

/** Wraps a request in a promise. */
function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

/** Wraps a transaction's completion. */
export function transactionAsPromise(
	transaction: IDBTransaction,
): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
	});
}

/**
 * Create the object store and its indexes.
 *
 * Kept as a separate function so a future version bump adds its migration step
 * beside this one instead of rewriting the open path.
 */
function createSchema(database: IDBDatabase): void {
	const store = database.createObjectStore(RECORDS_STORE, { keyPath: "id" });

	// Time-ordered access: pagination, range filters and eviction all read this.
	store.createIndex(INDEX_UPDATED, "updatedAt", { unique: false });
	// Deduplication point lookup. Unique, so correctness is enforced by the
	// database rather than trusted to the caller.
	store.createIndex(INDEX_DEDUPE, "dedupeKey", { unique: true });
	// Language-pair filter. Compound so the pair is one key, not two lookups.
	store.createIndex(INDEX_LANGPAIR, ["sourceLang", "targetLang"], {
		unique: false,
	});
	// IndexedDB does not index boolean values: a `favorite: false` record simply
	// gets no index entry. The indexed field is therefore a number (0 or 1) and
	// the boolean is derived from it at the boundary.
	store.createIndex(INDEX_FAVORITE, "favoriteFlag", { unique: false });
}

/**
 * Open the history database.
 *
 * Applies schema migrations for older versions, so an install created by an
 * earlier build is upgraded in place rather than discarded.
 */
export function openHistoryDatabase(
	factory: IDBFactory | undefined = typeof indexedDB === "undefined"
		? undefined
		: indexedDB,
): Promise<OpenResult> {
	if (!factory) {
		return Promise.resolve({ ok: false, reason: "当前浏览器不支持 IndexedDB" });
	}

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = factory.open(DATABASE_NAME, DATABASE_VERSION);
		} catch (error) {
			resolve({ ok: false, reason: `无法打开本地数据库：${String(error)}` });
			return;
		}

		request.onupgradeneeded = () => {
			const database = request.result;
			// Version 1 is the initial schema. Later versions add their own branch
			// here, using the old version to decide what to apply.
			if (!database.objectStoreNames.contains(RECORDS_STORE)) {
				createSchema(database);
			}
		};

		request.onsuccess = () => resolve({ ok: true, db: request.result });
		request.onerror = () =>
			resolve({
				ok: false,
				reason: request.error?.message ?? "打开本地数据库失败",
			});
		// A blocked open means an older tab holds the previous version. Treat it as
		// unavailable rather than waiting indefinitely.
		request.onblocked = () =>
			resolve({ ok: false, reason: "本地数据库被其他标签页占用" });
	});
}

/** Generate a record id. */
function newId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The stored shape: a record plus its dedupe key and the indexable favourite flag. */
interface StoredRecord extends HistoryRecord {
	readonly dedupeKey: string;
	/** `1` when favourite, `0` otherwise. Indexed because booleans cannot be. */
	readonly favoriteFlag: number;
}

/** Attach the storage-only fields (dedupe key and numeric favourite flag). */
function withKey(record: HistoryRecord): StoredRecord {
	return {
		...record,
		favoriteFlag: record.favorite ? 1 : 0,
		dedupeKey: dedupeKey({
			sourceText: record.sourceText,
			sourceLang: record.sourceLang,
			targetLang: record.targetLang,
			...(record.detectedLang !== undefined && {
				detectedLang: record.detectedLang,
			}),
		}),
	};
}

/** Look up an existing record by its dedupe key. */
async function findByDedupeKey(
	database: IDBDatabase,
	key: string,
): Promise<StoredRecord | undefined> {
	const transaction = database.transaction(RECORDS_STORE, "readonly");
	const index = transaction.objectStore(RECORDS_STORE).index(INDEX_DEDUPE);
	const found = await requestAsPromise(
		index.get(key) as IDBRequest<StoredRecord | undefined>,
	);
	return found;
}

/**
 * Insert or update a record, deduplicating by key.
 *
 * Idempotent: translating the same text twice refreshes one record rather than
 * accumulating. Returns whether the record was inserted (versus updated) so the
 * caller can log it.
 */
export async function writeRecord(
	database: IDBDatabase,
	input: HistoryRecordInput,
	now: number = Date.now(),
): Promise<WriteResult> {
	try {
		const key = dedupeKey({
			sourceText: input.sourceText,
			sourceLang: input.sourceLang,
			targetLang: input.targetLang,
			...(input.detectedLang !== undefined && {
				detectedLang: input.detectedLang,
			}),
		});

		const existing = await findByDedupeKey(database, key);

		const record: HistoryRecord = existing
			? {
					...existing,
					targetText: input.targetText,
					model: input.model,
					updatedAt: now,
					...(input.durationMs !== undefined && {
						durationMs: input.durationMs,
					}),
				}
			: {
					id: newId(),
					sourceText: input.sourceText,
					targetText: input.targetText,
					sourceLang: input.sourceLang,
					targetLang: input.targetLang,
					model: input.model,
					...(input.detectedLang !== undefined && {
						detectedLang: input.detectedLang,
					}),
					favorite: false,
					createdAt: now,
					updatedAt: now,
					...(input.durationMs !== undefined && {
						durationMs: input.durationMs,
					}),
				};

		const transaction = database.transaction(RECORDS_STORE, "readwrite");
		transaction.objectStore(RECORDS_STORE).put(withKey(record));
		await transactionAsPromise(transaction);

		logger.debug("history.db.write", {
			id: record.id,
			inserted: existing === undefined,
			sourceLang: record.sourceLang,
			targetLang: record.targetLang,
		});

		return { ok: true, record, inserted: existing === undefined };
	} catch (error) {
		logger.warn("history.db.write_failed", { error: String(error) });
		return { ok: false, reason: `写入历史失败：${String(error)}` };
	}
}

/** Read the records that are not favourites. */
function readNonFavorites(database: IDBDatabase): Promise<HistoryRecord[]> {
	return new Promise((resolve, reject) => {
		const results: HistoryRecord[] = [];
		const transaction = database.transaction(RECORDS_STORE, "readonly");
		const index = transaction.objectStore(RECORDS_STORE).index(INDEX_FAVORITE);

		// Only non-favourites (`favoriteFlag === 0`) are eviction candidates.
		const request = index.openCursor(globalThis.IDBKeyRange?.only(0) ?? null);

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(results);
				return;
			}
			const record = cursor.value as StoredRecord;
			// Guard as well as relying on the key range, so a missing `IDBKeyRange`
			// global cannot silently make favourites evictable.
			if (record.favorite !== true) results.push(record);
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("读取历史失败"));
	});
}

/**
 * Evict the oldest non-favourite records until the count is within `limit`.
 *
 * Called after every write so "the store stays bounded" is an invariant of the
 * write path rather than something a periodic task is trusted to enforce.
 * Favourites are never candidates: a record the user explicitly protected must
 * not be deleted by an automatic rule.
 */
export async function evictOverLimit(
	database: IDBDatabase,
	limit: number = DEFAULT_RECORD_LIMIT,
): Promise<number> {
	const candidates = await readNonFavorites(database);
	if (candidates.length <= limit) return 0;

	// Oldest first, so the newest survive.
	candidates.sort((a, b) => a.updatedAt - b.updatedAt);
	const excess = candidates.slice(0, candidates.length - limit);

	const transaction = database.transaction(RECORDS_STORE, "readwrite");
	const store = transaction.objectStore(RECORDS_STORE);
	for (const record of excess) store.delete(record.id);
	await transactionAsPromise(transaction);

	logger.info("history.db.evicted", { count: excess.length });

	return excess.length;
}

/** Count stored records. */
export async function countRecords(database: IDBDatabase): Promise<number> {
	const transaction = database.transaction(RECORDS_STORE, "readonly");
	return requestAsPromise(
		transaction.objectStore(RECORDS_STORE).count() as IDBRequest<number>,
	);
}

/** Mark a record as a favourite or clear the mark. */
export async function setFavorite(
	database: IDBDatabase,
	id: string,
	favorite: boolean,
	now: number = Date.now(),
): Promise<boolean> {
	return mutateRecord(database, id, (record) => ({
		...record,
		favorite,
		updatedAt: now,
	}));
}

/** Delete one record. */
export async function deleteRecord(
	database: IDBDatabase,
	id: string,
): Promise<boolean> {
	try {
		const transaction = database.transaction(RECORDS_STORE, "readwrite");
		transaction.objectStore(RECORDS_STORE).delete(id);
		await transactionAsPromise(transaction);
		logger.debug("history.db.delete", { id });
		return true;
	} catch {
		return false;
	}
}

/** Delete many records. */
export async function deleteRecords(
	database: IDBDatabase,
	ids: readonly string[],
): Promise<number> {
	if (ids.length === 0) return 0;

	const transaction = database.transaction(RECORDS_STORE, "readwrite");
	const store = transaction.objectStore(RECORDS_STORE);
	for (const id of ids) store.delete(id);
	await transactionAsPromise(transaction);
	logger.debug("history.db.delete_many", { count: ids.length });

	return ids.length;
}

/** Remove every record. */
export async function clearAll(database: IDBDatabase): Promise<boolean> {
	try {
		const transaction = database.transaction(RECORDS_STORE, "readwrite");
		transaction.objectStore(RECORDS_STORE).clear();
		await transactionAsPromise(transaction);
		logger.info("history.db.clear");
		return true;
	} catch {
		return false;
	}
}

/** Apply a transformation to one record. */
async function mutateRecord(
	database: IDBDatabase,
	id: string,
	update: (record: HistoryRecord) => HistoryRecord,
): Promise<boolean> {
	try {
		const readTransaction = database.transaction(RECORDS_STORE, "readonly");
		const store = readTransaction.objectStore(RECORDS_STORE);
		// The `id` key path means a direct get is already a point lookup.
		const existing = await requestAsPromise(
			store.get(id) as IDBRequest<HistoryRecord | undefined>,
		);
		if (!existing) return false;

		const writeTransaction = database.transaction(RECORDS_STORE, "readwrite");
		writeTransaction.objectStore(RECORDS_STORE).put(withKey(update(existing)));
		await transactionAsPromise(writeTransaction);
		return true;
	} catch {
		return false;
	}
}

/** Whether a keyword matches either side of a record. */
function matchesKeyword(record: HistoryRecord, keyword: string): boolean {
	const needle = keyword.trim().toLowerCase();
	if (needle === "") return true;

	return (
		record.sourceText.toLowerCase().includes(needle) ||
		record.targetText.toLowerCase().includes(needle)
	);
}

/** Whether a record passes the non-keyword conditions. */
function matchesFilters(record: HistoryRecord, filter: HistoryFilter): boolean {
	if (filter.favoritesOnly === true && !record.favorite) return false;
	if (
		filter.sourceLang !== undefined &&
		record.sourceLang !== filter.sourceLang
	)
		return false;
	if (
		filter.targetLang !== undefined &&
		record.targetLang !== filter.targetLang
	)
		return false;
	if (filter.since !== undefined && record.updatedAt < filter.since)
		return false;
	if (filter.until !== undefined && record.updatedAt > filter.until)
		return false;
	return true;
}

/**
 * Read a page of records, newest first.
 *
 * Iterates the `by_updated` index in descending order, so ordering comes from the
 * index rather than from loading and sorting everything.
 */
export async function readPage(
	database: IDBDatabase,
	options: {
		readonly offset?: number;
		readonly limit?: number;
		readonly filter?: HistoryFilter;
	} = {},
): Promise<HistoryPage> {
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(1, options.limit ?? 20);
	const filter = options.filter ?? {};

	return new Promise((resolve, reject) => {
		const transaction = database.transaction(RECORDS_STORE, "readonly");
		const index = transaction.objectStore(RECORDS_STORE).index(INDEX_UPDATED);

		const records: HistoryRecord[] = [];
		let skipped = 0;
		let hasMore = false;

		// Descending iteration over the time index.
		const request = index.openCursor(null, "prev");

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve({ records, hasMore });
				return;
			}

			const record = cursor.value as HistoryRecord;

			if (matchesFilters(record, filter)) {
				if (skipped < offset) {
					skipped += 1;
				} else if (records.length < limit) {
					records.push(record);
				} else {
					// One record beyond the page proves there is more to load.
					hasMore = true;
					resolve({ records, hasMore });
					return;
				}
			}

			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("读取历史失败"));
	});
}

/**
 * Search records by keyword, newest first, stopping once a page is filled.
 *
 * Complete results are the point: a match anywhere in the store must appear, so
 * the scan continues past non-matches instead of stopping at the first page of
 * *records*. Early termination applies only to collecting enough *matches*, which
 * keeps the common case cheap without ever hiding a hit (design.md D4).
 */
export async function searchRecords(
	database: IDBDatabase,
	keyword: string,
	options: {
		readonly offset?: number;
		readonly limit?: number;
		readonly filter?: HistoryFilter;
	} = {},
): Promise<HistoryPage & { readonly scanned: number }> {
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(1, options.limit ?? 20);
	const filter = { ...(options.filter ?? {}), keyword };

	return new Promise((resolve, reject) => {
		const transaction = database.transaction(RECORDS_STORE, "readonly");
		const index = transaction.objectStore(RECORDS_STORE).index(INDEX_UPDATED);

		const records: HistoryRecord[] = [];
		let matched = 0;
		let scanned = 0;
		let hasMore = false;

		const request = index.openCursor(null, "prev");

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve({ records, hasMore, scanned });
				return;
			}

			scanned += 1;
			const record = cursor.value as HistoryRecord;

			if (matchesFilters(record, filter) && matchesKeyword(record, keyword)) {
				if (matched < offset) {
					matched += 1;
				} else if (records.length < limit) {
					records.push(record);
					matched += 1;
					// Enough matches for this page: stop scanning. This ends the scan
					// on matches collected, never on records visited.
					if (records.length === limit) {
						hasMore = true;
						resolve({ records, hasMore, scanned });
						return;
					}
				}
			}

			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("读取历史失败"));
	});
}

/** Load every record for export, newest first. */
export async function readAll(database: IDBDatabase): Promise<HistoryRecord[]> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(RECORDS_STORE, "readonly");
		const index = transaction.objectStore(RECORDS_STORE).index(INDEX_UPDATED);

		const records: HistoryRecord[] = [];
		const request = index.openCursor(null, "prev");

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(records);
				return;
			}
			records.push(cursor.value as HistoryRecord);
			cursor.continue();
		};
		request.onerror = () => reject(request.error ?? new Error("读取历史失败"));
	});
}

/** Load specific records by id, for a scoped export. */
export async function readByIds(
	database: IDBDatabase,
	ids: readonly string[],
): Promise<HistoryRecord[]> {
	if (ids.length === 0) return [];

	const transaction = database.transaction(RECORDS_STORE, "readonly");
	const store = transaction.objectStore(RECORDS_STORE);

	const found: HistoryRecord[] = [];
	for (const id of ids) {
		const record = await requestAsPromise(
			store.get(id) as IDBRequest<HistoryRecord | undefined>,
		);
		if (record) found.push(record);
	}

	return found;
}

/**
 * Import records, merging by dedupe key.
 *
 * Never clears existing data: the worst outcome of importing the wrong file is
 * extra records, not lost history. Reports how many entries were skipped so the
 * user is told rather than left guessing.
 */
export async function importRecords(
	database: IDBDatabase,
	rawRecords: readonly unknown[],
	now: number = Date.now(),
): Promise<{
	readonly imported: number;
	readonly skipped: number;
	readonly reasons: readonly string[];
}> {
	let imported = 0;
	let skipped = 0;
	const reasons: string[] = [];

	for (const raw of rawRecords) {
		const validated = validateRecord(raw);
		if (!validated.ok) {
			skipped += 1;
			if (reasons.length < 5) reasons.push(validated.reason);
			continue;
		}

		// Reuse the normal write path so import inherits deduplication, rather
		// than implementing a second merge rule.
		const result = await writeRecord(database, validated.record, now);
		if (result.ok) imported += 1;
		else {
			skipped += 1;
			if (reasons.length < 5) reasons.push(result.reason);
		}
	}

	return { imported, skipped, reasons };
}

/** Export payload shape. */
export const EXPORT_VERSION = 1;

/** Build the export payload for a set of records. */
export function buildExportPayload(
	records: readonly HistoryRecord[],
	exportedAt: string,
): {
	readonly version: number;
	readonly exportedAt: string;
	readonly records: readonly Record<string, unknown>[];
} {
	return {
		version: EXPORT_VERSION,
		exportedAt,
		records: records.map(toExportable),
	};
}
