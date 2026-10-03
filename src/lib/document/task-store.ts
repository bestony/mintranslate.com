/**
 * Document task persistence.
 *
 * A separate IndexedDB database rather than new stores on the history or memory
 * databases: adding stores to an existing database requires a version bump, and a
 * version bump blocks when another tab holds the old version open. A new database
 * has no such coupling (`local-history` identified that risk already).
 *
 * Two kinds of record, with deliberately different lifetimes:
 *
 * - **task**: text only — the chunks and their results. Small, and the thing that
 *   makes a task resumable.
 * - **source**: the original file bytes, needed only to rebuild the delivered
 *   document. Large (up to 20MB), and deleted as soon as it is no longer needed.
 *
 * Keeping them apart is what makes "no terminal task pins a 20MB file" enforceable.
 */

import { logger } from "../logger";
import {
	type DocumentTaskRecord,
	isTerminal,
	type TranslatedChunk,
} from "./model";

/** Database and store names. */
export const DOCUMENT_DB_NAME = "mintranslate-documents";
export const DOCUMENT_DB_VERSION = 1;
export const TASKS_STORE = "tasks";
export const SOURCES_STORE = "sources";

/** Index over the last update, so the most recent tasks are cheap to list. */
export const INDEX_UPDATED = "by_updated";

/** Open the database, or return `undefined` when it is unavailable. */
export function openDocumentDatabase(): Promise<IDBDatabase | undefined> {
	if (typeof indexedDB === "undefined") return Promise.resolve(undefined);

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(DOCUMENT_DB_NAME, DOCUMENT_DB_VERSION);
		} catch (error) {
			logger.warn("document.db.open.failed", {
				reason: error instanceof Error ? error.message : String(error),
			});
			resolve(undefined);
			return;
		}

		request.onupgradeneeded = () => {
			const database = request.result;

			if (!database.objectStoreNames.contains(TASKS_STORE)) {
				const store = database.createObjectStore(TASKS_STORE, {
					keyPath: "id",
				});
				store.createIndex(INDEX_UPDATED, "updatedAt", { unique: false });
			}
			if (!database.objectStoreNames.contains(SOURCES_STORE)) {
				database.createObjectStore(SOURCES_STORE, { keyPath: "id" });
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			logger.warn("document.db.open.failed", {
				reason: request.error?.message ?? "unknown",
			});
			resolve(undefined);
		};
		// Another tab is holding an older version open. Reported rather than waited on,
		// so the interface can say storage is unavailable instead of hanging.
		request.onblocked = () => {
			logger.warn("document.db.blocked", {});
			resolve(undefined);
		};
	});
}

/** Promise wrapper for a request. */
function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("indexeddb error"));
	});
}

/** Resolve only after a transaction commits, or reject when it aborts. */
function transactionAsPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		const fail = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
		transaction.oncomplete = () => resolve();
		transaction.onerror = fail;
		transaction.onabort = fail;
	});
}

/** Persistence surface for tasks. */
export interface DocumentTaskStore {
	save(record: DocumentTaskRecord): Promise<void>;
	load(id: string): Promise<DocumentTaskRecord | undefined>;
	list(): Promise<readonly DocumentTaskRecord[]>;
	remove(id: string): Promise<void>;
	/** Store the original file for a task. */
	saveSource(id: string, bytes: Uint8Array): Promise<void>;
	loadSource(id: string): Promise<Uint8Array | undefined>;
	/** Delete the original file, keeping the task record. */
	dropSource(id: string): Promise<void>;
	/** Delete every task's original file except the one being processed. */
	dropStaleSources(keepId?: string): Promise<void>;
}

/** Create a store over a database handle. */
export function createDocumentTaskStore(
	database: IDBDatabase,
): DocumentTaskStore {
	async function withStore<T>(
		name: string,
		mode: IDBTransactionMode,
		run: (store: IDBObjectStore) => IDBRequest<T>,
	): Promise<T> {
		const transaction = database.transaction(name, mode);
		const request = run(transaction.objectStore(name));
		if (mode === "readwrite") {
			await transactionAsPromise(transaction);
			return request.result;
		}
		return requestAsPromise(request);
	}

	return {
		async save(record) {
			await withStore(TASKS_STORE, "readwrite", (store) => store.put(record));
		},

		async load(id) {
			return withStore<DocumentTaskRecord | undefined>(
				TASKS_STORE,
				"readonly",
				(store) => store.get(id) as IDBRequest<DocumentTaskRecord | undefined>,
			);
		},

		async list() {
			const all = await withStore<DocumentTaskRecord[]>(
				TASKS_STORE,
				"readonly",
				(store) => store.getAll() as IDBRequest<DocumentTaskRecord[]>,
			);
			return [...all].sort((left, right) => right.updatedAt - left.updatedAt);
		},

		async remove(id) {
			await withStore(TASKS_STORE, "readwrite", (store) => store.delete(id));
			// The source is useless without its task record.
			await this.dropSource(id);
		},

		async saveSource(id, bytes) {
			await withStore(SOURCES_STORE, "readwrite", (store) =>
				store.put({ id, bytes }),
			);
		},

		async loadSource(id) {
			const found = await withStore<
				{ id: string; bytes: Uint8Array } | undefined
			>(
				SOURCES_STORE,
				"readonly",
				(store) =>
					store.get(id) as IDBRequest<
						{ id: string; bytes: Uint8Array } | undefined
					>,
			);
			return found?.bytes;
		},

		async dropSource(id) {
			await withStore(SOURCES_STORE, "readwrite", (store) => store.delete(id));
		},

		async dropStaleSources(keepId) {
			const tasks = await this.list();
			const mostRecentResumableId = tasks.find(
				(task) => task.state === "failed",
			)?.id;
			for (const task of tasks) {
				if (task.id === keepId) continue;
				if (!isTerminal(task.state)) continue;
				// Keep one source for the newest failed or cancelled task so it remains
				// resumable. Succeeded tasks and older terminal tasks are disposable.
				if (task.id === mostRecentResumableId) continue;
				await this.dropSource(task.id);
			}
		},
	};
}

/** Open a store, or `undefined` when storage is unavailable. */
export async function openDocumentTaskStore(): Promise<
	DocumentTaskStore | undefined
> {
	const database = await openDocumentDatabase();
	return database === undefined ? undefined : createDocumentTaskStore(database);
}

/** An empty task record. */
export function createTaskRecord(options: {
	readonly id: string;
	readonly fileName: string;
	readonly format: DocumentTaskRecord["format"];
	readonly sourceLang: string;
	readonly targetLang: string;
	readonly styleId: string;
	readonly chunks: readonly TranslatedChunk[];
	readonly now: number;
}): DocumentTaskRecord {
	return {
		id: options.id,
		fileName: options.fileName,
		format: options.format,
		sourceLang: options.sourceLang,
		targetLang: options.targetLang,
		styleId: options.styleId,
		state: "queued",
		chunks: options.chunks,
		createdAt: options.now,
		updatedAt: options.now,
	};
}
