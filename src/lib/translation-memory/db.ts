/** IndexedDB schema and small promise adapters for translation memory. */

export const TRANSLATION_MEMORY_DATABASE_NAME = "mintranslate-memory";
export const TRANSLATION_MEMORY_DATABASE_VERSION = 1;
export const MEMORY_RECORDS_STORE = "records";
export const MEMORY_NGRAMS_STORE = "ngrams";

export const MEMORY_INDEX_EXACT = "by_exact";
export const MEMORY_INDEX_SOURCE_HASH = "by_source_hash";
export const MEMORY_INDEX_UPDATED = "by_updated";
export const MEMORY_INDEX_PAIR = "by_pair";
export const MEMORY_INDEX_ORIGIN = "by_origin";
export const MEMORY_INDEX_HIT = "by_hit";
export const MEMORY_NGRAM_INDEX_GRAM = "by_gram";
export const MEMORY_NGRAM_INDEX_RECORD = "by_record";

export type MemoryOpenResult =
	| { readonly ok: true; readonly db: IDBDatabase }
	| { readonly ok: false; readonly reason: string };

/** Convert one IndexedDB request to a promise. */
export function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

/** Resolve when an IndexedDB transaction commits. */
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

function createSchema(database: IDBDatabase): void {
	const records = database.createObjectStore(MEMORY_RECORDS_STORE, {
		keyPath: "id",
	});
	records.createIndex(MEMORY_INDEX_EXACT, "exactKey", { unique: true });
	records.createIndex(MEMORY_INDEX_SOURCE_HASH, "sourceHash", {
		unique: false,
	});
	records.createIndex(MEMORY_INDEX_UPDATED, "updatedAt", { unique: false });
	records.createIndex(MEMORY_INDEX_PAIR, ["sl", "tl"], { unique: false });
	records.createIndex(MEMORY_INDEX_ORIGIN, "origin", { unique: false });
	records.createIndex(MEMORY_INDEX_HIT, "hitCount", { unique: false });

	const ngrams = database.createObjectStore(MEMORY_NGRAMS_STORE, {
		keyPath: "key",
	});
	ngrams.createIndex(MEMORY_NGRAM_INDEX_GRAM, "gram", { unique: false });
	ngrams.createIndex(MEMORY_NGRAM_INDEX_RECORD, "recordId", { unique: false });
}

/** Open the independent memory database without touching the history database. */
export function openTranslationMemoryDatabase(
	factory: IDBFactory | undefined = typeof indexedDB === "undefined"
		? undefined
		: indexedDB,
): Promise<MemoryOpenResult> {
	if (!factory) {
		return Promise.resolve({ ok: false, reason: "当前浏览器不支持 IndexedDB" });
	}

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		let settled = false;
		const finish = (result: MemoryOpenResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		try {
			request = factory.open(
				TRANSLATION_MEMORY_DATABASE_NAME,
				TRANSLATION_MEMORY_DATABASE_VERSION,
			);
		} catch (error) {
			finish({ ok: false, reason: `无法打开本地数据库：${String(error)}` });
			return;
		}

		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(MEMORY_RECORDS_STORE)) {
				createSchema(database);
			}
		};
		request.onsuccess = () => finish({ ok: true, db: request.result });
		request.onerror = () =>
			finish({
				ok: false,
				reason: request.error?.message ?? "打开翻译记忆数据库失败",
			});
		request.onblocked = () =>
			finish({ ok: false, reason: "翻译记忆数据库被其他标签页占用" });
	});
}

/** Test and embed seam for a memory store backed by a particular factory. */
export function openMemoryDatabase(
	factory?: IDBFactory,
): Promise<MemoryOpenResult> {
	return openTranslationMemoryDatabase(factory);
}
