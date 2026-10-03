/**
 * IndexedDB storage for runtime diagnostic logs.
 *
 * Provides a dedicated local log repository:
 * - Single object store `records` with autoincrement primary key.
 * - B-tree index `by_timestamp` for O(log n) range queries.
 * - B-tree index `by_level` for severity filtering.
 * - Batch writes and bounded retention to prevent runaway storage.
 */

import type { LogLevel, LogRecord } from "../index";

export const LOG_DATABASE_NAME = "mintranslate-logs";
export const LOG_DATABASE_VERSION = 1;
export const LOG_RECORDS_STORE = "records";
export const INDEX_TIMESTAMP = "by_timestamp";
export const INDEX_LEVEL = "by_level";

export const DEFAULT_MAX_LOG_RECORDS = 5000;

export interface StoredLogRecord {
	readonly id?: number;
	readonly level: LogLevel;
	readonly event: string;
	readonly timestamp: number;
	readonly isoTime: string;
	readonly requestId?: string;
	readonly fields: Record<string, unknown>;
}

export type OpenLogDbResult =
	| { readonly ok: true; readonly db: IDBDatabase }
	| { readonly ok: false; readonly reason: string };

export interface LogQueryOptions {
	readonly since?: number;
	readonly until?: number;
	readonly limit?: number;
	readonly direction?: "next" | "prev";
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB log request failed"));
	});
}

function transactionAsPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(
				transaction.error ?? new Error("IndexedDB log transaction failed"),
			);
		transaction.onabort = () =>
			reject(
				transaction.error ?? new Error("IndexedDB log transaction aborted"),
			);
	});
}

function createLogSchema(database: IDBDatabase): void {
	const store = database.createObjectStore(LOG_RECORDS_STORE, {
		keyPath: "id",
		autoIncrement: true,
	});

	// Range queries over time windows: O(log n) tree lookup.
	store.createIndex(INDEX_TIMESTAMP, "timestamp", { unique: false });
	// Filtering by severity level.
	store.createIndex(INDEX_LEVEL, "level", { unique: false });
}

/**
 * Open the runtime diagnostic logs database.
 */
export function openLogDatabase(
	factory: IDBFactory | undefined = typeof indexedDB === "undefined"
		? undefined
		: indexedDB,
): Promise<OpenLogDbResult> {
	if (!factory) {
		return Promise.resolve({
			ok: false,
			reason: "当前环境不支持 IndexedDB",
		});
	}

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = factory.open(LOG_DATABASE_NAME, LOG_DATABASE_VERSION);
		} catch (error) {
			resolve({
				ok: false,
				reason: `无法打开日志数据库: ${String(error)}`,
			});
			return;
		}

		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(LOG_RECORDS_STORE)) {
				createLogSchema(database);
			}
		};

		request.onsuccess = () => resolve({ ok: true, db: request.result });
		request.onerror = () =>
			resolve({
				ok: false,
				reason: request.error?.message ?? "打开日志数据库失败",
			});
		request.onblocked = () =>
			resolve({
				ok: false,
				reason: "日志数据库被其他页面标签占用",
			});
	});
}

/** Convert a LogRecord to the shape stored in IndexedDB. */
export function toStoredLogRecord(record: LogRecord): StoredLogRecord {
	return {
		level: record.level,
		event: record.event,
		timestamp: record.timestamp,
		isoTime: new Date(record.timestamp).toISOString(),
		...(record.requestId !== undefined && { requestId: record.requestId }),
		fields: { ...record.fields },
	};
}

/**
 * Insert a single log record.
 */
export async function writeLogRecord(
	database: IDBDatabase,
	record: LogRecord,
): Promise<void> {
	const transaction = database.transaction(LOG_RECORDS_STORE, "readwrite");
	const store = transaction.objectStore(LOG_RECORDS_STORE);
	store.add(toStoredLogRecord(record));
	await transactionAsPromise(transaction);
}

/**
 * Insert a batch of log records in a single transaction.
 */
export async function writeLogBatch(
	database: IDBDatabase,
	records: readonly LogRecord[],
): Promise<void> {
	if (records.length === 0) return;

	const transaction = database.transaction(LOG_RECORDS_STORE, "readwrite");
	const store = transaction.objectStore(LOG_RECORDS_STORE);
	for (const record of records) {
		store.add(toStoredLogRecord(record));
	}
	await transactionAsPromise(transaction);
}

/**
 * Build an IDBKeyRange for time window queries.
 */
export function makeKeyRange(
	since?: number,
	until?: number,
	keyRangeFactory: typeof IDBKeyRange | undefined = typeof IDBKeyRange ===
	"undefined"
		? globalThis.IDBKeyRange
		: IDBKeyRange,
): IDBKeyRange | null {
	if (!keyRangeFactory) {
		return null;
	}
	if (since !== undefined && until !== undefined) {
		return keyRangeFactory.bound(since, until);
	}
	if (since !== undefined) {
		return keyRangeFactory.lowerBound(since);
	}
	if (until !== undefined) {
		return keyRangeFactory.upperBound(until);
	}
	return null;
}

/**
 * Query log records by timestamp range using the B-tree index.
 *
 * Complexity: O(log n + m) where m is the number of records in the range.
 */
export async function queryLogsByRange(
	database: IDBDatabase,
	options: LogQueryOptions = {},
	keyRangeFactory?: typeof IDBKeyRange,
): Promise<StoredLogRecord[]> {
	const { since, until, limit, direction = "next" } = options;
	const keyRange = makeKeyRange(since, until, keyRangeFactory);

	return new Promise((resolve, reject) => {
		const transaction = database.transaction(LOG_RECORDS_STORE, "readonly");
		const index = transaction
			.objectStore(LOG_RECORDS_STORE)
			.index(INDEX_TIMESTAMP);
		const results: StoredLogRecord[] = [];

		const request = index.openCursor(keyRange, direction);

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(results);
				return;
			}

			const record = cursor.value as StoredLogRecord;

			// Guard in case IDBKeyRange was unavailable in environment
			if (since !== undefined && record.timestamp < since) {
				cursor.continue();
				return;
			}
			if (until !== undefined && record.timestamp > until) {
				if (direction === "next") {
					// Ascending traversal can terminate early once beyond upper bound
					resolve(results);
					return;
				}
				cursor.continue();
				return;
			}

			results.push(record);

			if (limit !== undefined && results.length >= limit) {
				resolve(results);
				return;
			}

			cursor.continue();
		};

		request.onerror = () => {
			reject(request.error ?? new Error("读取日志失败"));
		};
	});
}

/** Count stored records. */
export async function countLogs(database: IDBDatabase): Promise<number> {
	const transaction = database.transaction(LOG_RECORDS_STORE, "readonly");
	return requestAsPromise(
		transaction.objectStore(LOG_RECORDS_STORE).count() as IDBRequest<number>,
	);
}

/** Remove all stored logs. */
export async function clearLogs(database: IDBDatabase): Promise<void> {
	const transaction = database.transaction(LOG_RECORDS_STORE, "readwrite");
	transaction.objectStore(LOG_RECORDS_STORE).clear();
	await transactionAsPromise(transaction);
}

/**
 * Prune oldest records if total count exceeds keepLimit.
 */
export async function pruneOldLogs(
	database: IDBDatabase,
	keepLimit: number = DEFAULT_MAX_LOG_RECORDS,
): Promise<number> {
	if (keepLimit < 0) {
		throw new RangeError("日志保留上限不能为负数");
	}

	const total = await countLogs(database);
	if (total <= keepLimit) {
		return 0;
	}

	const excessCount = total - keepLimit;

	return new Promise((resolve, reject) => {
		const transaction = database.transaction(LOG_RECORDS_STORE, "readwrite");
		const store = transaction.objectStore(LOG_RECORDS_STORE);
		const index = store.index(INDEX_TIMESTAMP);

		let deleted = 0;
		transaction.oncomplete = () => resolve(deleted);
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("修剪日志事务失败"));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("修剪日志事务已中止"));

		// Traverse oldest first to delete excess
		const request = index.openCursor(null, "next");

		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor || deleted >= excessCount) {
				return;
			}

			cursor.delete();
			deleted += 1;
			cursor.continue();
		};

		request.onerror = () => {
			reject(request.error ?? new Error("修剪日志失败"));
		};
	});
}
