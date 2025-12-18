import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	BaseCollectionConfig,
	CollectionConfig,
	DeleteMutationFnParams,
	InferSchemaOutput,
	InsertMutationFnParams,
	PendingMutation,
	SyncConfig,
	UpdateMutationFnParams,
	UtilsRecord,
} from "@tanstack/react-db";

type PersistedValue<T extends object> = {
	value: T;
	updatedAt: number;
};

export type IndexedDBIndexConfig = {
	name: string;
	keyPath: string | string[];
	options?: IDBIndexParameters;
};

export interface IndexedDBCollectionConfig<
	T extends object = object,
	TSchema extends StandardSchemaV1 = never,
	TKey extends IDBValidKey = IDBValidKey,
> extends BaseCollectionConfig<T, TKey, TSchema> {
	databaseName: string;
	storeName: string;
	version?: number;
	indexes?: IndexedDBIndexConfig[];
}

export interface IndexedDBCollectionUtils extends UtilsRecord {
	clearStore: () => Promise<void>;
}

type IndexedDBCollectionOptionsResult<
	T extends object,
	TKey extends IDBValidKey,
	TSchema extends StandardSchemaV1 | never = never,
> = CollectionConfig<T, TKey, TSchema, IndexedDBCollectionUtils> & {
	id: string;
	utils: IndexedDBCollectionUtils;
};

function createTransactionDonePromise(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		tx.addEventListener("complete", () => resolve(), { once: true });
		tx.addEventListener(
			"abort",
			() => reject(tx.error ?? new Error("IndexedDB transaction aborted")),
			{ once: true },
		);
		tx.addEventListener(
			"error",
			() => reject(tx.error ?? new Error("IndexedDB transaction failed")),
			{ once: true },
		);
	});
}

function createRequestPromise<TResult>(request: IDBRequest<TResult>) {
	return new Promise<TResult>((resolve, reject) => {
		request.addEventListener("success", () => resolve(request.result), {
			once: true,
		});
		request.addEventListener(
			"error",
			() => reject(request.error ?? new Error("IndexedDB request failed")),
			{ once: true },
		);
	});
}

async function getAllPersistedValues<T extends object>(
	db: IDBDatabase,
	storeName: string,
) {
	const tx = db.transaction(storeName, "readonly");
	const store = tx.objectStore(storeName);
	const request = store.getAll() as IDBRequest<Array<PersistedValue<T>>>;
	const items = await createRequestPromise(request);
	await createTransactionDonePromise(tx);
	return items;
}

async function setPersistedValues<T extends object>(
	db: IDBDatabase,
	storeName: string,
	mutations: Array<PendingMutation<T>>,
) {
	const tx = db.transaction(storeName, "readwrite");
	const store = tx.objectStore(storeName);

	for (const mutation of mutations) {
		const key = mutation.key as IDBValidKey;
		if (mutation.type === "delete") {
			store.delete(key);
			continue;
		}

		const payload: PersistedValue<T> = {
			value: mutation.modified,
			updatedAt: Date.now(),
		};
		store.put(payload, key);
	}

	await createTransactionDonePromise(tx);
}

async function clearStore(db: IDBDatabase, storeName: string) {
	const tx = db.transaction(storeName, "readwrite");
	tx.objectStore(storeName).clear();
	await createTransactionDonePromise(tx);
}

function openIndexedDB(
	databaseName: string,
	version: number | undefined,
	configure: (params: { db: IDBDatabase; transaction: IDBTransaction }) => void,
) {
	return new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof globalThis.indexedDB === "undefined") {
			reject(new Error("IndexedDB is not available in this environment"));
			return;
		}

		const request =
			typeof version === "number"
				? globalThis.indexedDB.open(databaseName, version)
				: globalThis.indexedDB.open(databaseName);

		request.addEventListener(
			"upgradeneeded",
			() => {
				if (!request.transaction) {
					reject(new Error("IndexedDB upgrade transaction missing"));
					return;
				}

				configure({ db: request.result, transaction: request.transaction });
			},
			{ once: true },
		);
		request.addEventListener(
			"success",
			() => {
				const db = request.result;
				db.addEventListener("versionchange", () => {
					db.close();
				});
				resolve(db);
			},
			{ once: true },
		);
		request.addEventListener(
			"error",
			() => reject(request.error ?? new Error("IndexedDB open failed")),
			{ once: true },
		);
	});
}

function ensureIndexes(store: IDBObjectStore, indexes: IndexedDBIndexConfig[]) {
	if (!indexes.length) return;

	for (const index of indexes) {
		if (store.indexNames.contains(index.name)) continue;
		store.createIndex(index.name, index.keyPath, index.options);
	}
}

function ensureObjectStore(
	db: IDBDatabase,
	transaction: IDBTransaction,
	storeName: string,
) {
	if (db.objectStoreNames.contains(storeName)) {
		return transaction.objectStore(storeName);
	}

	return db.createObjectStore(storeName);
}

async function needsUpgrade(
	db: IDBDatabase,
	storeName: string,
	indexes: IndexedDBIndexConfig[],
	minVersion: number,
) {
	if (db.version < minVersion) return true;
	if (!db.objectStoreNames.contains(storeName)) return true;
	if (!indexes.length) return false;

	const tx = db.transaction(storeName, "readonly");
	const store = tx.objectStore(storeName);

	const missingIndex = indexes.some(
		(index) => !store.indexNames.contains(index.name),
	);
	store.count();
	await createTransactionDonePromise(tx);

	return missingIndex;
}

function confirmOperationsSync<T extends object, TKey extends IDBValidKey>(
	syncParams: Parameters<SyncConfig<T, TKey>["sync"]>[0] | null,
	mutations: Array<PendingMutation<T>>,
) {
	if (!syncParams) return;
	const { begin, write, commit } = syncParams;

	begin();
	for (const mutation of mutations) {
		if (mutation.type === "delete") {
			if (mutation.original && Object.keys(mutation.original).length) {
				write({ type: "delete", value: mutation.original as T });
			}
			continue;
		}
		write({ type: mutation.type, value: mutation.modified });
	}
	commit();
}

// Overload for when schema is provided
export function indexedDBCollectionOptions<
	T extends StandardSchemaV1,
	TKey extends IDBValidKey = IDBValidKey,
>(
	config: IndexedDBCollectionConfig<InferSchemaOutput<T>, T, TKey> & {
		schema: T;
	},
): IndexedDBCollectionOptionsResult<InferSchemaOutput<T>, TKey, T> & {
	schema: T;
};

// Overload for when no schema is provided
export function indexedDBCollectionOptions<
	T extends object,
	TKey extends IDBValidKey = IDBValidKey,
>(
	config: IndexedDBCollectionConfig<T, never, TKey> & {
		schema?: never;
	},
): IndexedDBCollectionOptionsResult<T, TKey> & {
	schema?: never;
};

export function indexedDBCollectionOptions<
	T extends object = object,
	TSchema extends StandardSchemaV1 = never,
	TKey extends IDBValidKey = IDBValidKey,
>(
	config: IndexedDBCollectionConfig<T, TSchema, TKey>,
): IndexedDBCollectionOptionsResult<T, TKey, TSchema> & {
	schema?: StandardSchemaV1;
} {
	const {
		databaseName,
		storeName,
		version = 1,
		indexes = [],
		onInsert,
		onUpdate,
		onDelete,
		id,
		...restConfig
	} = config;

	let dbPromise: Promise<IDBDatabase> | null = null;
	let syncParams: Parameters<SyncConfig<T, TKey>["sync"]>[0] | null = null;

	const getDb = () => {
		dbPromise ??= (async () => {
			const configure = ({
				db,
				transaction,
			}: {
				db: IDBDatabase;
				transaction: IDBTransaction;
			}) => {
				const store = ensureObjectStore(db, transaction, storeName);
				ensureIndexes(store, indexes);
			};

			const initial = await openIndexedDB(databaseName, undefined, configure);

			if (await needsUpgrade(initial, storeName, indexes, version)) {
				const upgradeVersion = Math.max(version, initial.version + 1);
				initial.close();
				return openIndexedDB(databaseName, upgradeVersion, configure);
			}

			return initial;
		})();
		return dbPromise;
	};

	const sync: SyncConfig<T, TKey> = {
		sync: (params) => {
			syncParams = params;
			let cancelled = false;

			void (async () => {
				try {
					const db = await getDb();
					if (cancelled) return;

					const rows = await getAllPersistedValues<T>(db, storeName);
					if (cancelled) return;

					if (rows.length) {
						params.begin();
						for (const row of rows) {
							params.write({ type: "insert", value: row.value });
						}
						params.commit();
					}

					params.markReady();
				} catch (error) {
					console.error(
						`[indexedDBCollectionOptions] failed to sync "${databaseName}/${storeName}"`,
						error,
					);
					params.markReady();
				}
			})();

			return () => {
				cancelled = true;
			};
		},
		getSyncMetadata: () => ({
			databaseName,
			storeName,
			version,
		}),
	};

	const wrappedOnInsert = async (params: InsertMutationFnParams<T, TKey>) => {
		let handlerResult: unknown = {};
		if (onInsert) handlerResult = (await onInsert(params)) ?? {};

		const db = await getDb();
		await setPersistedValues(db, storeName, params.transaction.mutations);
		confirmOperationsSync(syncParams, params.transaction.mutations);

		return handlerResult;
	};

	const wrappedOnUpdate = async (params: UpdateMutationFnParams<T, TKey>) => {
		let handlerResult: unknown = {};
		if (onUpdate) handlerResult = (await onUpdate(params)) ?? {};

		const db = await getDb();
		await setPersistedValues(db, storeName, params.transaction.mutations);
		confirmOperationsSync(syncParams, params.transaction.mutations);

		return handlerResult;
	};

	const wrappedOnDelete = async (params: DeleteMutationFnParams<T, TKey>) => {
		let handlerResult: unknown = {};
		if (onDelete) handlerResult = (await onDelete(params)) ?? {};

		const db = await getDb();
		await setPersistedValues(db, storeName, params.transaction.mutations);
		confirmOperationsSync(syncParams, params.transaction.mutations);

		return handlerResult;
	};

	const clearStoreUtil = async () => {
		const db = await getDb();
		await clearStore(db, storeName);
	};

	const collectionId =
		id ?? `indexeddb-collection:${databaseName}/${storeName}`;

	return {
		...restConfig,
		id: collectionId,
		sync,
		onInsert: wrappedOnInsert,
		onUpdate: wrappedOnUpdate,
		onDelete: wrappedOnDelete,
		utils: {
			clearStore: clearStoreUtil,
		},
	};
}
