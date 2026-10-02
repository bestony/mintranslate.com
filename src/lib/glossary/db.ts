/** IndexedDB schema and low-level operations for the glossary. */

import {
	type GlossaryTerm,
	type LanguagePair,
	normalizeLanguage,
	normalizeSource,
	pairKey,
} from "./model";

export const GLOSSARY_DATABASE_NAME = "mintranslate-glossary";
export const GLOSSARY_DATABASE_VERSION = 1;
export const TERMS_STORE = "terms";
export const VERSIONS_STORE = "versions";
/** Short aliases matching the naming used by the history database wrapper. */
export const DATABASE_NAME = GLOSSARY_DATABASE_NAME;
export const DATABASE_VERSION = GLOSSARY_DATABASE_VERSION;
export const INDEX_PAIR = "by_pair";
export const INDEX_PAIR_SOURCE = "by_pair_source";
export const INDEX_TARGET = "by_target";

export type GlossaryOpenResult =
	| { readonly ok: true; readonly db: IDBDatabase }
	| { readonly ok: false; readonly reason: string };

export interface StoredGlossaryTerm extends GlossaryTerm {
	readonly pairKey: string;
	readonly normalizedSource: string;
	readonly slKey: string;
	readonly tlKey: string;
}

interface StoredVersion {
	readonly pairKey: string;
	readonly version: string;
	readonly updatedAt: number;
}

export function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

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
	const terms = database.createObjectStore(TERMS_STORE, { keyPath: "id" });
	terms.createIndex(INDEX_PAIR, ["slKey", "tlKey"], { unique: false });
	terms.createIndex(INDEX_PAIR_SOURCE, ["slKey", "tlKey", "normalizedSource"], {
		unique: true,
	});
	terms.createIndex(INDEX_TARGET, "tlKey", { unique: false });
	database.createObjectStore(VERSIONS_STORE, { keyPath: "pairKey" });
}

export function openGlossaryDatabase(
	factory: IDBFactory | undefined = typeof indexedDB === "undefined"
		? undefined
		: indexedDB,
): Promise<GlossaryOpenResult> {
	if (!factory)
		return Promise.resolve({ ok: false, reason: "当前浏览器不支持 IndexedDB" });

	return new Promise((resolve) => {
		let request: IDBOpenDBRequest;
		try {
			request = factory.open(GLOSSARY_DATABASE_NAME, GLOSSARY_DATABASE_VERSION);
		} catch (error) {
			resolve({ ok: false, reason: `无法打开术语数据库：${String(error)}` });
			return;
		}

		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(TERMS_STORE))
				createSchema(database);
		};
		request.onsuccess = () => {
			const database = request.result;
			database.onversionchange = () => database.close();
			resolve({ ok: true, db: database });
		};
		request.onerror = () =>
			resolve({
				ok: false,
				reason: request.error?.message ?? "打开术语数据库失败",
			});
		request.onblocked = () =>
			resolve({ ok: false, reason: "术语数据库被其他标签页占用" });
	});
}

function keyRangeOnly(value: IDBValidKey): IDBKeyRange | null {
	if (typeof IDBKeyRange === "undefined") return null;
	return IDBKeyRange.only(value);
}

function toStoredTerm(term: GlossaryTerm): StoredGlossaryTerm {
	const slKey = normalizeLanguage(term.sl);
	const tlKey = normalizeLanguage(term.tl);
	return {
		...term,
		pairKey: pairKey(term),
		normalizedSource: normalizeSource(term.source),
		slKey,
		tlKey,
	};
}

function fromStoredTerm(value: StoredGlossaryTerm): GlossaryTerm {
	return {
		id: value.id,
		source: value.source,
		target: value.target,
		sl: value.sl,
		tl: value.tl,
		caseSensitive: value.caseSensitive,
		note: value.note,
		priority: value.priority,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

export async function readTermById(
	database: IDBDatabase,
	id: string,
): Promise<GlossaryTerm | undefined> {
	const transaction = database.transaction(TERMS_STORE, "readonly");
	const value = await requestAsPromise(
		transaction.objectStore(TERMS_STORE).get(id) as IDBRequest<
			StoredGlossaryTerm | undefined
		>,
	);
	return value === undefined ? undefined : fromStoredTerm(value);
}

export async function readAllTerms(
	database: IDBDatabase,
): Promise<GlossaryTerm[]> {
	const transaction = database.transaction(TERMS_STORE, "readonly");
	const values = await requestAsPromise(
		transaction.objectStore(TERMS_STORE).getAll() as IDBRequest<
			StoredGlossaryTerm[]
		>,
	);
	return values.map(fromStoredTerm);
}

export async function readTermsByPair(
	database: IDBDatabase,
	pair: LanguagePair,
): Promise<GlossaryTerm[]> {
	const transaction = database.transaction(TERMS_STORE, "readonly");
	const index = transaction.objectStore(TERMS_STORE).index(INDEX_PAIR);
	const range = keyRangeOnly([
		normalizeLanguage(pair.sl),
		normalizeLanguage(pair.tl),
	]);
	const values = await requestAsPromise(
		index.getAll(range) as IDBRequest<StoredGlossaryTerm[]>,
	);
	const terms = values.map(fromStoredTerm);
	if (range !== null) return terms;
	return terms.filter(
		(term) =>
			normalizeLanguage(term.sl) === normalizeLanguage(pair.sl) &&
			normalizeLanguage(term.tl) === normalizeLanguage(pair.tl),
	);
}

export async function readTermsByTarget(
	database: IDBDatabase,
	target: string,
): Promise<GlossaryTerm[]> {
	const transaction = database.transaction(TERMS_STORE, "readonly");
	const index = transaction.objectStore(TERMS_STORE).index(INDEX_TARGET);
	const range = keyRangeOnly(normalizeLanguage(target));
	const values = await requestAsPromise(
		index.getAll(range) as IDBRequest<StoredGlossaryTerm[]>,
	);
	const terms = values.map(fromStoredTerm);
	if (range !== null) return terms;
	return terms.filter(
		(term) => normalizeLanguage(term.tl) === normalizeLanguage(target),
	);
}

export async function findTermByKey(
	database: IDBDatabase,
	input: Pick<GlossaryTerm, "source" | "sl" | "tl">,
): Promise<GlossaryTerm | undefined> {
	const key = [
		normalizeLanguage(input.sl),
		normalizeLanguage(input.tl),
		normalizeSource(input.source),
	];
	const transaction = database.transaction(TERMS_STORE, "readonly");
	const value = await requestAsPromise(
		transaction
			.objectStore(TERMS_STORE)
			.index(INDEX_PAIR_SOURCE)
			.get(key) as IDBRequest<StoredGlossaryTerm | undefined>,
	);
	return value === undefined ? undefined : fromStoredTerm(value);
}

function nextVersion(previous: string | undefined, now: number): string {
	return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}-${previous ?? "0"}`;
}

export async function readGlossaryVersion(
	database: IDBDatabase,
	pair: LanguagePair,
): Promise<string> {
	const transaction = database.transaction(VERSIONS_STORE, "readonly");
	const value = await requestAsPromise(
		transaction.objectStore(VERSIONS_STORE).get(pairKey(pair)) as IDBRequest<
			StoredVersion | undefined
		>,
	);
	return value?.version ?? "0";
}

export async function bumpGlossaryVersion(
	database: IDBDatabase,
	pair: LanguagePair,
	now: number = Date.now(),
): Promise<string> {
	const key = pairKey(pair);
	const transaction = database.transaction(VERSIONS_STORE, "readwrite");
	const store = transaction.objectStore(VERSIONS_STORE);
	const previous = await requestAsPromise(
		store.get(key) as IDBRequest<StoredVersion | undefined>,
	);
	const version = nextVersion(previous?.version, now);
	store.put({ pairKey: key, version, updatedAt: now } satisfies StoredVersion);
	await transactionAsPromise(transaction);
	return version;
}

export async function putTerm(
	database: IDBDatabase,
	term: GlossaryTerm,
): Promise<
	{ readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
	try {
		const transaction = database.transaction(TERMS_STORE, "readwrite");
		transaction.objectStore(TERMS_STORE).put(toStoredTerm(term));
		await transactionAsPromise(transaction);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `保存术语失败：${String(error)}` };
	}
}

export async function deleteTermById(
	database: IDBDatabase,
	id: string,
): Promise<
	{ readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
	try {
		const transaction = database.transaction(TERMS_STORE, "readwrite");
		transaction.objectStore(TERMS_STORE).delete(id);
		await transactionAsPromise(transaction);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `删除术语失败：${String(error)}` };
	}
}

export async function clearAllTerms(
	database: IDBDatabase,
): Promise<
	{ readonly ok: true } | { readonly ok: false; readonly reason: string }
> {
	try {
		const transaction = database.transaction(TERMS_STORE, "readwrite");
		transaction.objectStore(TERMS_STORE).clear();
		await transactionAsPromise(transaction);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `清空术语失败：${String(error)}` };
	}
}
