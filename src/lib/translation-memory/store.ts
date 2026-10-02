/**
 * Translation-memory store.
 *
 * All record and n-gram mutations are committed in the same IndexedDB
 * transaction. The public surface is deliberately browser-neutral so the
 * controller can inject a test double without knowing anything about IDB.
 */

import { logger } from "../logger";
import {
	MEMORY_INDEX_EXACT,
	MEMORY_INDEX_HIT,
	MEMORY_INDEX_UPDATED,
	MEMORY_NGRAM_INDEX_GRAM,
	MEMORY_NGRAM_INDEX_RECORD,
	MEMORY_NGRAMS_STORE,
	MEMORY_RECORDS_STORE,
	type MemoryOpenResult,
	openTranslationMemoryDatabase,
	requestAsPromise,
	transactionAsPromise,
} from "./db";
import { hashMemoryFingerprint } from "./hash";
import {
	clampMemorySourceText,
	DEFAULT_MEMORY_LIMIT,
	type LanguagePair,
	type MemoryContext,
	type MemoryOrigin,
	normalizeMemoryContext,
	normalizeMemoryText,
	pairTranslationSegments,
	type TranslationMemoryInput,
	type TranslationMemoryRecord,
	validateMemoryInput,
} from "./model";
import { containsNormalizedText, diceCoefficient, getNgrams } from "./ngrams";
import {
	buildJsonExport,
	buildTmxExport,
	type ImportPayload,
	parseJsonExport,
	parseTmxExport,
} from "./transfer";

/** A synchronous or asynchronous hash implementation for collision tests. */
export type MemoryHashProvider = (
	fingerprint: string,
) => string | Promise<string>;

export interface TranslationMemoryStoreOptions {
	readonly db: IDBDatabase;
	readonly now?: () => number;
	readonly maxRecords?: number;
	readonly hash?: MemoryHashProvider;
}

export interface ExactMemoryQuery extends Partial<MemoryContext> {
	readonly sourceText: string;
}

export interface MemoryWriteResult {
	readonly ok: true;
	readonly record: TranslationMemoryRecord;
	readonly inserted: boolean;
	readonly protectedUserEdit: boolean;
}

export interface MemoryErrorResult {
	readonly ok: false;
	readonly reason: string;
}

export type MemoryWriteOutcome = MemoryWriteResult | MemoryErrorResult;

export type MemorySort = "updatedAt" | "hitCount";
export type MemorySortDirection = "asc" | "desc";

export interface MemoryFilter {
	readonly keyword?: string;
	readonly sl?: string;
	readonly tl?: string;
	readonly origin?: MemoryOrigin;
	readonly since?: number;
	readonly until?: number;
}

export interface MemoryQueryOptions {
	readonly filter?: MemoryFilter;
	readonly sort?: MemorySort;
	readonly direction?: MemorySortDirection;
	readonly limit?: number;
	readonly cursor?: string;
	/** Offset is retained for simple callers; cursor pagination is preferred. */
	readonly offset?: number;
}

export interface MemoryPage {
	readonly records: readonly TranslationMemoryRecord[];
	readonly hasMore: boolean;
	readonly nextCursor?: string;
	readonly scanned: number;
}

export interface SimilarMemoryResult {
	readonly record: TranslationMemoryRecord;
	readonly score: number;
}

export interface SimilarMemoryOptions {
	readonly threshold?: number;
	readonly limit?: number;
}

export interface MemoryStats {
	readonly total: number;
	readonly byLanguagePair: Readonly<Record<string, number>>;
	readonly hitRate: number;
	readonly hitRecords: number;
}

export interface MemoryImportResult {
	readonly imported: number;
	readonly skipped: number;
	readonly reasons: readonly string[];
	readonly evicted: number;
}

/** Minimal interface consumed by the translation controller. */
export interface TranslationMemoryPort {
	findTranslation(
		sourceText: string,
		context: Partial<MemoryContext>,
	): Promise<string | undefined>;
	writeTranslation(
		sourceText: string,
		targetText: string,
		context: Partial<MemoryContext>,
	): Promise<readonly TranslationMemoryRecord[]>;
	/** Optional similarity lookup used for prompt references after an exact miss. */
	findSimilar?: (
		text: string,
		pair: LanguagePair,
		options?: SimilarMemoryOptions,
	) => Promise<readonly SimilarMemoryResult[]>;
}

interface StoredMemoryRecord extends TranslationMemoryRecord {
	readonly exactKey: string;
	readonly fingerprint: string;
	readonly normalizedSource: string;
	readonly hitSort: number;
}

interface StoredNgram {
	readonly key: string;
	readonly gram: string;
	readonly recordId: string;
	readonly field: "source" | "target";
}

interface PreparedKey {
	readonly fingerprint: string;
	readonly sourceHash: string;
	readonly exactKey: string;
	readonly context: MemoryContext;
	readonly normalizedSource: string;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 20000;

function newId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function keyRangeOnly(value: IDBValidKey): IDBKeyRange | null {
	return typeof IDBKeyRange === "undefined" ? null : IDBKeyRange.only(value);
}

function recordFromStored(record: StoredMemoryRecord): TranslationMemoryRecord {
	const {
		exactKey: _exactKey,
		fingerprint: _fingerprint,
		normalizedSource: _normalizedSource,
		hitSort: _hitSort,
		...publicRecord
	} = record;
	return publicRecord;
}

function originRank(origin: MemoryOrigin): number {
	// Model and imported rows both participate in the same LRU order. A
	// user-edit row is protected until all non-user edits have been considered.
	return origin === "user-edit" ? 1 : 0;
}

function cursorEncode(value: { sort: number; id: string }): string {
	return encodeURIComponent(JSON.stringify(value));
}

function cursorDecode(
	value: string | undefined,
): { sort: number; id: string } | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { sort?: unknown }).sort === "number" &&
			typeof (parsed as { id?: unknown }).id === "string"
		) {
			return parsed as { sort: number; id: string };
		}
	} catch {
		// An invalid cursor is treated as the first page rather than breaking the UI.
	}
	return undefined;
}

function sortValue(record: StoredMemoryRecord, sort: MemorySort): number {
	return sort === "hitCount" ? record.hitCount : record.updatedAt;
}

function compareRecords(
	left: StoredMemoryRecord,
	right: StoredMemoryRecord,
	sort: MemorySort,
	direction: MemorySortDirection,
): number {
	const leftValue = sortValue(left, sort);
	const rightValue = sortValue(right, sort);
	if (leftValue !== rightValue) {
		const difference = leftValue - rightValue;
		return direction === "asc" ? difference : -difference;
	}
	return direction === "asc"
		? left.id.localeCompare(right.id)
		: right.id.localeCompare(left.id);
}

function isAfterCursor(
	record: StoredMemoryRecord,
	cursor: { sort: number; id: string } | undefined,
	sort: MemorySort,
	direction: MemorySortDirection,
): boolean {
	if (!cursor) return true;
	const value = sortValue(record, sort);
	if (value !== cursor.sort) {
		return direction === "asc" ? value > cursor.sort : value < cursor.sort;
	}
	return direction === "asc"
		? record.id.localeCompare(cursor.id) > 0
		: record.id.localeCompare(cursor.id) < 0;
}

function pairKey(sl: string, tl: string): string {
	return `${sl}\u0000${tl}`;
}

function ngramKey(gram: string, recordId: string, field: "source" | "target") {
	return `${gram}\u0000${recordId}\u0000${field}`;
}

async function readById(
	db: IDBDatabase,
	id: string,
): Promise<StoredMemoryRecord | undefined> {
	const transaction = db.transaction(MEMORY_RECORDS_STORE, "readonly");
	return (await requestAsPromise(
		transaction.objectStore(MEMORY_RECORDS_STORE).get(id),
	)) as StoredMemoryRecord | undefined;
}

async function readByExactKey(
	db: IDBDatabase,
	exactKey: string,
): Promise<StoredMemoryRecord | undefined> {
	const transaction = db.transaction(MEMORY_RECORDS_STORE, "readonly");
	const index = transaction
		.objectStore(MEMORY_RECORDS_STORE)
		.index(MEMORY_INDEX_EXACT);
	return (await requestAsPromise(index.get(exactKey))) as
		| StoredMemoryRecord
		| undefined;
}

async function readByIds(
	db: IDBDatabase,
	ids: readonly string[],
): Promise<StoredMemoryRecord[]> {
	if (ids.length === 0) return [];
	const transaction = db.transaction(MEMORY_RECORDS_STORE, "readonly");
	const store = transaction.objectStore(MEMORY_RECORDS_STORE);
	const records: StoredMemoryRecord[] = [];
	for (const id of ids) {
		const record = (await requestAsPromise(store.get(id))) as
			| StoredMemoryRecord
			| undefined;
		if (record) records.push(record);
	}
	return records;
}

async function readAllStored(db: IDBDatabase): Promise<StoredMemoryRecord[]> {
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(MEMORY_RECORDS_STORE, "readonly");
		const request = transaction.objectStore(MEMORY_RECORDS_STORE).getAll();
		request.onsuccess = () => resolve(request.result as StoredMemoryRecord[]);
		request.onerror = () =>
			reject(request.error ?? new Error("读取翻译记忆失败"));
	});
}

async function readNgramsForGram(
	db: IDBDatabase,
	gram: string,
): Promise<StoredNgram[]> {
	const transaction = db.transaction(MEMORY_NGRAMS_STORE, "readonly");
	const index = transaction
		.objectStore(MEMORY_NGRAMS_STORE)
		.index(MEMORY_NGRAM_INDEX_GRAM);
	const range = keyRangeOnly(gram);
	const request = range === null ? index.getAll() : index.getAll(range);
	const entries = (await requestAsPromise(request)) as StoredNgram[];
	return range === null
		? entries.filter((entry) => entry.gram === gram)
		: entries;
}

async function readNgramsForRecord(
	db: IDBDatabase,
	recordId: string,
): Promise<StoredNgram[]> {
	const transaction = db.transaction(MEMORY_NGRAMS_STORE, "readonly");
	const index = transaction
		.objectStore(MEMORY_NGRAMS_STORE)
		.index(MEMORY_NGRAM_INDEX_RECORD);
	const range = keyRangeOnly(recordId);
	const request = range === null ? index.getAll() : index.getAll(range);
	const entries = (await requestAsPromise(request)) as StoredNgram[];
	return range === null
		? entries.filter((entry) => entry.recordId === recordId)
		: entries;
}

async function readNgramKeys(
	db: IDBDatabase,
	recordId: string,
): Promise<readonly string[]> {
	const entries = await readNgramsForRecord(db, recordId);
	return entries.map((entry) => entry.key);
}

function deleteNgramKeysInTransaction(
	store: IDBObjectStore,
	keys: readonly string[],
): void {
	for (const key of keys) store.delete(key);
}

function addNgramsInTransaction(
	store: IDBObjectStore,
	record: StoredMemoryRecord,
): void {
	const values: readonly ["source" | "target", string][] = [
		["source", record.sourceText],
		["target", record.targetText],
	];
	for (const [field, text] of values) {
		for (const gram of getNgrams(text)) {
			const entry: StoredNgram = {
				key: ngramKey(gram, record.id, field),
				gram,
				recordId: record.id,
				field,
			};
			store.put(entry);
		}
	}
}

function toStoredRecord(
	input: TranslationMemoryInput,
	key: PreparedKey,
	existing: StoredMemoryRecord | undefined,
	now: number,
): StoredMemoryRecord {
	const origin = input.origin ?? "model";
	const createdAt = existing?.createdAt ?? input.createdAt ?? now;
	const updatedAt = input.updatedAt ?? now;
	const hitCount = input.hitCount ?? existing?.hitCount ?? 0;
	const lastHitAt = input.lastHitAt ?? existing?.lastHitAt;
	return {
		id: existing?.id ?? input.id ?? newId(),
		sourceText: clampMemorySourceText(input.sourceText),
		targetText: input.targetText,
		...key.context,
		sourceHash: key.sourceHash,
		origin,
		createdAt,
		updatedAt,
		hitCount,
		...(lastHitAt !== undefined && { lastHitAt }),
		exactKey: key.exactKey,
		fingerprint: key.fingerprint,
		normalizedSource: key.normalizedSource,
		hitSort: lastHitAt ?? createdAt,
	};
}

function matchingFilter(
	record: StoredMemoryRecord,
	filter: MemoryFilter | undefined,
): boolean {
	if (!filter) return true;
	if (filter.sl !== undefined && record.sl !== filter.sl) return false;
	if (filter.tl !== undefined && record.tl !== filter.tl) return false;
	if (filter.origin !== undefined && record.origin !== filter.origin)
		return false;
	if (filter.since !== undefined && record.updatedAt < filter.since)
		return false;
	if (filter.until !== undefined && record.updatedAt > filter.until)
		return false;
	if (
		filter.keyword !== undefined &&
		!containsNormalizedText(
			filter.keyword,
			record.sourceText,
			record.targetText,
		)
	) {
		return false;
	}
	return true;
}

/** Concrete IndexedDB-backed store. */
export class TranslationMemoryStore implements TranslationMemoryPort {
	readonly db: IDBDatabase;
	private readonly now: () => number;
	private readonly maxRecords: number;
	private readonly hash: MemoryHashProvider;

	constructor(options: TranslationMemoryStoreOptions) {
		this.db = options.db;
		this.now = options.now ?? (() => Date.now());
		this.maxRecords = options.maxRecords ?? DEFAULT_MEMORY_LIMIT;
		this.hash =
			options.hash ?? ((fingerprint) => hashMemoryFingerprint(fingerprint));
	}

	private async prepareKey(
		sourceText: string,
		context: Partial<MemoryContext>,
	): Promise<PreparedKey> {
		const normalizedContext = normalizeMemoryContext(context);
		const normalizedSource = normalizeMemoryText(sourceText);
		const fingerprint = [
			`${normalizedSource.length}:${normalizedSource}`,
			`${normalizedContext.sl.length}:${normalizedContext.sl}`,
			`${normalizedContext.tl.length}:${normalizedContext.tl}`,
			`${normalizedContext.glossaryVersion.length}:${normalizedContext.glossaryVersion}`,
			`${normalizedContext.styleId.length}:${normalizedContext.styleId}`,
			`${normalizedContext.tier.length}:${normalizedContext.tier}`,
		].join("|");
		const sourceHash = await this.hash(fingerprint);
		return {
			fingerprint,
			sourceHash,
			exactKey: `${sourceHash}:${fingerprint}`,
			context: normalizedContext,
			normalizedSource,
		};
	}

	/** Write one paragraph pair and enforce the capacity invariant. */
	async put(input: TranslationMemoryInput): Promise<MemoryWriteOutcome> {
		const startedAt = this.now();
		if (normalizeMemoryText(input.sourceText) === "") {
			return { ok: false, reason: "原文不能为空" };
		}
		const key = await this.prepareKey(input.sourceText, input);
		const existing = await readByExactKey(this.db, key.exactKey);
		const protectedUserEdit =
			existing?.origin === "user-edit" && input.origin !== "user-edit";
		const record = protectedUserEdit
			? existing
			: toStoredRecord(input, key, existing, this.now());
		const oldNgramKeys =
			existing && !protectedUserEdit
				? await readNgramKeys(this.db, existing.id)
				: [];

		try {
			const transaction = this.db.transaction(
				[MEMORY_RECORDS_STORE, MEMORY_NGRAMS_STORE],
				"readwrite",
			);
			const records = transaction.objectStore(MEMORY_RECORDS_STORE);
			const ngrams = transaction.objectStore(MEMORY_NGRAMS_STORE);
			if (existing && !protectedUserEdit)
				deleteNgramKeysInTransaction(ngrams, oldNgramKeys);
			if (!existing || !protectedUserEdit) {
				records.put(record);
				if (!protectedUserEdit) addNgramsInTransaction(ngrams, record);
			}
			await transactionAsPromise(transaction);
		} catch (error) {
			return { ok: false, reason: `写入翻译记忆失败：${String(error)}` };
		}

		const evicted = await this.evictOverLimit();
		logger.info("translation-memory.write", {
			inserted: existing === undefined,
			protectedUserEdit,
			evicted,
			durationMs: this.now() - startedAt,
			origin: record.origin,
			textLength: record.sourceText.length,
		});
		return {
			ok: true,
			record: recordFromStored(record),
			inserted: existing === undefined,
			protectedUserEdit,
		};
	}

	/** Alias for callers that name the operation after the public resource. */
	async write(input: TranslationMemoryInput): Promise<MemoryWriteOutcome> {
		return this.put(input);
	}

	/** Write all paired segments, or one whole-text record when counts differ. */
	async writeTranslation(
		sourceText: string,
		targetText: string,
		context: Partial<MemoryContext> = {},
	): Promise<readonly TranslationMemoryRecord[]> {
		const records: TranslationMemoryRecord[] = [];
		for (const pair of pairTranslationSegments(sourceText, targetText)) {
			const outcome = await this.put({
				sourceText: pair.sourceText,
				targetText: pair.targetText,
				...context,
				origin: "model",
			});
			if (outcome.ok) records.push(outcome.record);
		}
		return records;
	}

	/**
	 * Insert or update a batch in one transaction.
	 *
	 * Importers and maintenance jobs can otherwise spend most of their time
	 * opening one IndexedDB transaction per segment. The exact-key map also makes
	 * duplicate rows in one payload deterministic: the last row wins.
	 */
	async putMany(
		inputs: readonly TranslationMemoryInput[],
	): Promise<readonly TranslationMemoryRecord[]> {
		if (inputs.length === 0) return [];
		const prepared = await Promise.all(
			inputs
				.filter((input) => normalizeMemoryText(input.sourceText) !== "")
				.map(async (input) => ({
					input,
					key: await this.prepareKey(input.sourceText, input),
				})),
		);
		const unique = new Map<string, (typeof prepared)[number]>();
		for (const entry of prepared) unique.set(entry.key.exactKey, entry);
		const entries = [...unique.values()];

		const readTransaction = this.db.transaction(
			MEMORY_RECORDS_STORE,
			"readonly",
		);
		const readIndex = readTransaction
			.objectStore(MEMORY_RECORDS_STORE)
			.index(MEMORY_INDEX_EXACT);
		const existing = await Promise.all(
			entries.map(
				(entry) =>
					requestAsPromise(readIndex.get(entry.key.exactKey)) as Promise<
						StoredMemoryRecord | undefined
					>,
			),
		);
		const oldNgramKeys = await Promise.all(
			existing.map((record) =>
				record ? readNgramKeys(this.db, record.id) : Promise.resolve([]),
			),
		);
		const records: StoredMemoryRecord[] = [];
		const protectedIds = new Set<string>();
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (!entry) continue;
			const old = existing[index];
			if (
				old &&
				old.origin === "user-edit" &&
				entry.input.origin !== "user-edit"
			) {
				protectedIds.add(old.id);
				records.push(old);
				continue;
			}
			records.push(toStoredRecord(entry.input, entry.key, old, this.now()));
		}

		try {
			const transaction = this.db.transaction(
				[MEMORY_RECORDS_STORE, MEMORY_NGRAMS_STORE],
				"readwrite",
			);
			const recordStore = transaction.objectStore(MEMORY_RECORDS_STORE);
			const ngramStore = transaction.objectStore(MEMORY_NGRAMS_STORE);
			for (let index = 0; index < entries.length; index += 1) {
				const entry = entries[index];
				const old = existing[index];
				const record = records[index];
				if (!entry || !record || protectedIds.has(record.id)) continue;
				if (old)
					deleteNgramKeysInTransaction(ngramStore, oldNgramKeys[index] ?? []);
				recordStore.put(record);
				addNgramsInTransaction(ngramStore, record);
			}
			await transactionAsPromise(transaction);
		} catch (error) {
			logger.warn("translation-memory.batch-write-failed", { error });
			return [];
		}

		const evicted = await this.evictOverLimit();
		logger.info("translation-memory.batch-write", {
			count: records.length,
			evicted,
		});
		return records.map(recordFromStored);
	}

	/** Find and mark one exact record as used. */
	async findExact(
		query: ExactMemoryQuery,
	): Promise<TranslationMemoryRecord | undefined> {
		const startedAt = this.now();
		const key = await this.prepareKey(query.sourceText, query);
		const existing = await readByExactKey(this.db, key.exactKey);
		if (!existing || existing.fingerprint !== key.fingerprint) {
			logger.debug("translation-memory.miss", {
				durationMs: this.now() - startedAt,
			});
			return undefined;
		}

		const now = this.now();
		const updated: StoredMemoryRecord = {
			...existing,
			hitCount: existing.hitCount + 1,
			lastHitAt: now,
			hitSort: now,
		};
		try {
			const transaction = this.db.transaction(
				MEMORY_RECORDS_STORE,
				"readwrite",
			);
			transaction.objectStore(MEMORY_RECORDS_STORE).put(updated);
			await transactionAsPromise(transaction);
		} catch (error) {
			logger.warn("translation-memory.hit-update-failed", {
				durationMs: this.now() - startedAt,
				error,
			});
			return recordFromStored(existing);
		}

		logger.info("translation-memory.hit", {
			durationMs: this.now() - startedAt,
			hitCount: updated.hitCount,
			sl: updated.sl,
			tl: updated.tl,
		});
		return recordFromStored(updated);
	}

	/** Find a whole translation first, then pair its existing segments. */
	async findTranslation(
		sourceText: string,
		context: Partial<MemoryContext> = {},
	): Promise<string | undefined> {
		const whole = await this.findExact({ sourceText, ...context });
		if (whole) return whole.targetText;

		const segments = pairTranslationSegments(sourceText, sourceText).map(
			(pair) => pair.sourceText,
		);
		if (segments.length <= 1) return undefined;
		const translations: string[] = [];
		for (const segment of segments) {
			const found = await this.findExact({ sourceText: segment, ...context });
			if (!found) return undefined;
			translations.push(found.targetText);
		}
		return translations.join("\n\n");
	}

	/** Update editable fields while preserving the record's identity and indexes. */
	async update(
		id: string,
		patch: Partial<
			Pick<
				TranslationMemoryRecord,
				| "sourceText"
				| "targetText"
				| "sl"
				| "tl"
				| "glossaryVersion"
				| "styleId"
				| "tier"
			>
		>,
	): Promise<MemoryWriteOutcome> {
		const existing = await readById(this.db, id);
		if (!existing) return { ok: false, reason: "未找到翻译记忆" };
		const input: TranslationMemoryInput = {
			...existing,
			...patch,
			id: existing.id,
			origin: "user-edit",
			createdAt: existing.createdAt,
		};
		const key = await this.prepareKey(input.sourceText, input);
		const sameKey = key.exactKey === existing.exactKey;
		const oldNgramKeys = await readNgramKeys(this.db, id);

		try {
			const transaction = this.db.transaction(
				[MEMORY_RECORDS_STORE, MEMORY_NGRAMS_STORE],
				"readwrite",
			);
			const records = transaction.objectStore(MEMORY_RECORDS_STORE);
			const ngrams = transaction.objectStore(MEMORY_NGRAMS_STORE);
			deleteNgramKeysInTransaction(ngrams, oldNgramKeys);
			const updated = toStoredRecord(
				input,
				key,
				{
					...existing,
					...(sameKey ? {} : { exactKey: key.exactKey }),
				},
				this.now(),
			);
			records.put(updated);
			addNgramsInTransaction(ngrams, updated);
			await transactionAsPromise(transaction);
			logger.info("translation-memory.edit", {
				durationMs: this.now() - existing.updatedAt,
			});
			return {
				ok: true,
				record: recordFromStored(updated),
				inserted: false,
				protectedUserEdit: false,
			};
		} catch (error) {
			return { ok: false, reason: `编辑翻译记忆失败：${String(error)}` };
		}
	}

	/** Delete one record and all of its n-gram entries. */
	async delete(id: string): Promise<boolean> {
		const existing = await readById(this.db, id);
		if (!existing) return false;
		const oldNgramKeys = await readNgramKeys(this.db, id);
		try {
			const transaction = this.db.transaction(
				[MEMORY_RECORDS_STORE, MEMORY_NGRAMS_STORE],
				"readwrite",
			);
			transaction.objectStore(MEMORY_RECORDS_STORE).delete(id);
			deleteNgramKeysInTransaction(
				transaction.objectStore(MEMORY_NGRAMS_STORE),
				oldNgramKeys,
			);
			await transactionAsPromise(transaction);
			logger.info("translation-memory.delete", { count: 1 });
			return true;
		} catch {
			return false;
		}
	}

	/** Delete many records in one transaction. */
	async deleteMany(ids: readonly string[]): Promise<number> {
		if (ids.length === 0) return 0;
		const oldNgramKeys = await Promise.all(
			ids.map((id) => readNgramKeys(this.db, id)),
		);
		try {
			const transaction = this.db.transaction(
				[MEMORY_RECORDS_STORE, MEMORY_NGRAMS_STORE],
				"readwrite",
			);
			const records = transaction.objectStore(MEMORY_RECORDS_STORE);
			const ngrams = transaction.objectStore(MEMORY_NGRAMS_STORE);
			for (let index = 0; index < ids.length; index += 1) {
				const id = ids[index];
				records.delete(id);
				deleteNgramKeysInTransaction(ngrams, oldNgramKeys[index] ?? []);
			}
			await transactionAsPromise(transaction);
			logger.info("translation-memory.delete-many", { count: ids.length });
			return ids.length;
		} catch {
			return 0;
		}
	}

	/** Clear records and persisted n-grams. */
	async clear(): Promise<boolean> {
		try {
			const transaction = this.db.transaction(
				[MEMORY_RECORDS_STORE, MEMORY_NGRAMS_STORE],
				"readwrite",
			);
			transaction.objectStore(MEMORY_RECORDS_STORE).clear();
			transaction.objectStore(MEMORY_NGRAMS_STORE).clear();
			await transactionAsPromise(transaction);
			logger.info("translation-memory.clear");
			return true;
		} catch {
			return false;
		}
	}

	/** Find similar source texts using n-gram candidates and Dice ranking. */
	async findSimilar(
		text: string,
		pair: LanguagePair,
		options: SimilarMemoryOptions = {},
	): Promise<readonly SimilarMemoryResult[]> {
		const startedAt = this.now();
		const threshold = options.threshold ?? 0.8;
		const limit = Math.max(1, Math.min(options.limit ?? 3, MAX_PAGE_LIMIT));
		const grams = getNgrams(text);
		if (grams.length === 0) return [];

		const counts = new Map<string, number>();
		for (const gram of grams) {
			for (const entry of await readNgramsForGram(this.db, gram)) {
				if (entry.field !== "source") continue;
				counts.set(entry.recordId, (counts.get(entry.recordId) ?? 0) + 1);
			}
		}
		const candidates = await readByIds(this.db, [...counts.keys()]);
		const queryGrams = new Set(grams);
		const ranked: SimilarMemoryResult[] = [];
		for (const record of candidates) {
			if (record.sl !== pair.sl || record.tl !== pair.tl) continue;
			const score = diceCoefficient(queryGrams, getNgrams(record.sourceText));
			if (score >= threshold) {
				ranked.push({ record: recordFromStored(record), score });
			}
		}
		ranked.sort(
			(left, right) =>
				right.score - left.score ||
				right.record.updatedAt - left.record.updatedAt ||
				left.record.id.localeCompare(right.record.id),
		);
		logger.info("translation-memory.similar", {
			candidates: candidates.length,
			results: Math.min(ranked.length, limit),
			durationMs: this.now() - startedAt,
		});
		return ranked.slice(0, limit);
	}

	/** Query indexed candidates and return a stable page. */
	async query(options: MemoryQueryOptions = {}): Promise<MemoryPage> {
		const startedAt = this.now();
		const filter = options.filter;
		const limit = Math.max(
			1,
			Math.min(options.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
		);
		const sort = options.sort ?? "updatedAt";
		const direction = options.direction ?? "desc";
		const cursor = cursorDecode(options.cursor);
		const offset = Math.max(0, options.offset ?? 0);
		const keyword = filter?.keyword?.trim() ?? "";
		let records: StoredMemoryRecord[];

		if (keyword !== "") {
			const candidateIds = new Set<string>();
			for (const gram of getNgrams(keyword)) {
				for (const entry of await readNgramsForGram(this.db, gram)) {
					candidateIds.add(entry.recordId);
				}
			}
			records = await readByIds(this.db, [...candidateIds]);
		} else {
			// Walk the requested ordering index and stop after one extra matching
			// record. This keeps ordinary list queries bounded instead of loading the
			// entire object store before applying filters.
			const indexName =
				sort === "hitCount" ? MEMORY_INDEX_HIT : MEMORY_INDEX_UPDATED;
			const direction = options.direction === "asc" ? "next" : "prev";
			const wanted = Math.max(1, offset + limit + 1);
			const indexed = await new Promise<{
				records: StoredMemoryRecord[];
				scanned: number;
			}>((resolve, reject) => {
				const transaction = this.db.transaction(
					MEMORY_RECORDS_STORE,
					"readonly",
				);
				const index = transaction
					.objectStore(MEMORY_RECORDS_STORE)
					.index(indexName);
				const request = index.openCursor(null, direction);
				const found: StoredMemoryRecord[] = [];
				let scanned = 0;
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor || found.length >= wanted) {
						resolve({ records: found, scanned });
						return;
					}
					scanned += 1;
					const record = cursor.value as StoredMemoryRecord;
					if (
						matchingFilter(record, filter) &&
						isAfterCursor(
							record,
							cursorDecode(options.cursor),
							sort,
							direction === "next" ? "asc" : "desc",
						)
					) {
						found.push(record);
					}
					cursor.continue();
				};
				request.onerror = () =>
					reject(request.error ?? new Error("查询翻译记忆失败"));
			});
			records = indexed.records;
			const pageRecords = records.slice(offset, offset + limit);
			const hasMore = records.length > offset + pageRecords.length;
			const last = pageRecords.at(-1);
			const nextCursor =
				hasMore && last
					? cursorEncode({ sort: sortValue(last, sort), id: last.id })
					: undefined;
			logger.info("translation-memory.query", {
				durationMs: this.now() - startedAt,
				matched: records.length,
				returned: pageRecords.length,
				scanned: indexed.scanned,
			});
			return {
				records: pageRecords.map(recordFromStored),
				hasMore,
				...(nextCursor !== undefined && { nextCursor }),
				scanned: indexed.scanned,
			};
		}

		records = records
			.filter((record) => matchingFilter(record, filter))
			.filter((record) => isAfterCursor(record, cursor, sort, direction))
			.sort((left, right) => compareRecords(left, right, sort, direction));

		const skipped = Math.min(offset, records.length);
		const pageRecords = records.slice(skipped, skipped + limit);
		const hasMore = records.length > skipped + pageRecords.length;
		const last = pageRecords.at(-1);
		const nextCursor =
			hasMore && last
				? cursorEncode({ sort: sortValue(last, sort), id: last.id })
				: undefined;
		logger.info("translation-memory.query", {
			durationMs: this.now() - startedAt,
			matched: records.length,
			returned: pageRecords.length,
			scanned: records.length,
		});
		return {
			records: pageRecords.map(recordFromStored),
			hasMore,
			...(nextCursor !== undefined && { nextCursor }),
			scanned: records.length,
		};
	}

	/** Keyword-oriented alias that preserves all other query filters. */
	async search(
		keyword: string,
		options: Omit<MemoryQueryOptions, "filter"> & {
			readonly filter?: Omit<MemoryFilter, "keyword">;
		} = {},
	): Promise<MemoryPage> {
		return this.query({
			...options,
			filter: { ...options.filter, keyword },
		});
	}

	/** Read all records for export or statistics. */
	async readAll(): Promise<readonly TranslationMemoryRecord[]> {
		return (await readAllStored(this.db)).map(recordFromStored);
	}

	/** Calculate local totals and hit rate. */
	async stats(): Promise<MemoryStats> {
		const records = await readAllStored(this.db);
		const byLanguagePair: Record<string, number> = {};
		let hitRecords = 0;
		for (const record of records) {
			const key = pairKey(record.sl, record.tl);
			byLanguagePair[key] = (byLanguagePair[key] ?? 0) + 1;
			if (record.hitCount > 0) hitRecords += 1;
		}
		return {
			total: records.length,
			byLanguagePair,
			hitRate: records.length === 0 ? 0 : hitRecords / records.length,
			hitRecords,
		};
	}

	/** Alias for UI stores that expose statistics as a getter. */
	async getStats(): Promise<MemoryStats> {
		return this.stats();
	}

	/** Evict records until the configured limit is satisfied. */
	async evictOverLimit(): Promise<number> {
		const records = await readAllStored(this.db);
		if (records.length <= this.maxRecords) return 0;
		const candidates = [...records].sort((left, right) => {
			const rank = originRank(left.origin) - originRank(right.origin);
			if (rank !== 0) return rank;
			const leftActivity = left.lastHitAt ?? left.createdAt;
			const rightActivity = right.lastHitAt ?? right.createdAt;
			return leftActivity - rightActivity || left.id.localeCompare(right.id);
		});
		const excess = candidates.slice(0, records.length - this.maxRecords);
		const removed = await this.deleteMany(excess.map((record) => record.id));
		if (removed > 0)
			logger.info("translation-memory.evicted", { count: removed });
		return removed;
	}

	/** Export JSON after applying optional filters. */
	async exportJson(filter?: MemoryFilter): Promise<string> {
		const records =
			filter === undefined
				? await this.readAll()
				: (await this.query({ filter, limit: MAX_PAGE_LIMIT })).records;
		const startedAt = this.now();
		const payload = buildJsonExport(records, new Date().toISOString());
		logger.info("translation-memory.export.json", {
			count: records.length,
			durationMs: this.now() - startedAt,
		});
		return payload;
	}

	/** Uppercase format alias matching the JSON file format name. */
	async exportJSON(filter?: MemoryFilter): Promise<string> {
		return this.exportJson(filter);
	}

	/** Export TMX 1.4b after applying optional filters. */
	async exportTmx(filter?: MemoryFilter): Promise<string> {
		const records =
			filter === undefined
				? await this.readAll()
				: (await this.query({ filter, limit: MAX_PAGE_LIMIT })).records;
		const startedAt = this.now();
		const payload = buildTmxExport(records);
		logger.info("translation-memory.export.tmx", {
			count: records.length,
			durationMs: this.now() - startedAt,
		});
		return payload;
	}

	/** Import JSON, merge by exact key, and report invalid rows. */
	async importJson(text: string): Promise<MemoryImportResult> {
		const parsed = parseJsonExport(text);
		if (!parsed.ok) throw new Error(parsed.reason);
		return this.importPayload(parsed);
	}

	/** Uppercase format alias matching the JSON file format name. */
	async importJSON(text: string): Promise<MemoryImportResult> {
		return this.importJson(text);
	}

	/** Import TMX 1.4b and merge its translation units. */
	async importTmx(text: string): Promise<MemoryImportResult> {
		const parsed = parseTmxExport(text);
		if (!parsed.ok) throw new Error(parsed.reason);
		return this.importPayload(parsed);
	}

	private async importPayload(
		payload: ImportPayload,
	): Promise<MemoryImportResult> {
		const startedAt = this.now();
		let imported = 0;
		let skipped = payload.skipped;
		const reasons = [...payload.reasons];
		for (const raw of payload.records) {
			const validated = validateMemoryInput(raw);
			if (!validated.ok) {
				skipped += 1;
				if (reasons.length < 10) reasons.push(validated.reason);
				continue;
			}
			const outcome = await this.put({
				...validated.input,
				origin: validated.input.origin === "user-edit" ? "user-edit" : "import",
			});
			if (outcome.ok) imported += 1;
			else {
				skipped += 1;
				if (reasons.length < 10) reasons.push(outcome.reason);
			}
		}
		const evicted = await this.evictOverLimit();
		logger.info("translation-memory.import", {
			imported,
			skipped,
			evicted,
			durationMs: this.now() - startedAt,
		});
		return { imported, skipped, reasons, evicted };
	}
}

export type MemoryStore = TranslationMemoryStore;

/** Function-style API for callers that do not keep methods on a store object. */
export function writeMemory(
	store: TranslationMemoryStore,
	input: TranslationMemoryInput,
): Promise<MemoryWriteOutcome> {
	return store.put(input);
}

export function findExactMemory(
	store: TranslationMemoryStore,
	query: ExactMemoryQuery,
): Promise<TranslationMemoryRecord | undefined> {
	return store.findExact(query);
}

export function queryMemory(
	store: TranslationMemoryStore,
	options: MemoryQueryOptions = {},
): Promise<MemoryPage> {
	return store.query(options);
}

export function findSimilar(
	store: TranslationMemoryStore,
	text: string,
	pair: LanguagePair,
	options: SimilarMemoryOptions = {},
): Promise<readonly SimilarMemoryResult[]> {
	return store.findSimilar(text, pair, options);
}

export function updateMemory(
	store: TranslationMemoryStore,
	id: string,
	patch: Parameters<TranslationMemoryStore["update"]>[1],
): Promise<MemoryWriteOutcome> {
	return store.update(id, patch);
}

export function deleteMemory(
	store: TranslationMemoryStore,
	id: string,
): Promise<boolean> {
	return store.delete(id);
}

export function deleteMemories(
	store: TranslationMemoryStore,
	ids: readonly string[],
): Promise<number> {
	return store.deleteMany(ids);
}

export function exportMemoryJson(
	store: TranslationMemoryStore,
	filter?: MemoryFilter,
): Promise<string> {
	return store.exportJson(filter);
}

export function exportMemoryTmx(
	store: TranslationMemoryStore,
	filter?: MemoryFilter,
): Promise<string> {
	return store.exportTmx(filter);
}

export function importMemoryJson(
	store: TranslationMemoryStore,
	text: string,
): Promise<MemoryImportResult> {
	return store.importJson(text);
}

export function importMemoryTmx(
	store: TranslationMemoryStore,
	text: string,
): Promise<MemoryImportResult> {
	return store.importTmx(text);
}

/** Create a store from an existing database connection. */
export function createTranslationMemoryStore(
	options: TranslationMemoryStoreOptions,
): TranslationMemoryStore {
	return new TranslationMemoryStore(options);
}

/** Open a store, returning an explicit unavailable result instead of throwing. */
export async function openTranslationMemoryStore(
	options: {
		readonly factory?: IDBFactory;
		readonly now?: () => number;
		readonly maxRecords?: number;
		readonly hash?: MemoryHashProvider;
	} = {},
): Promise<MemoryOpenResult & { readonly store?: TranslationMemoryStore }> {
	const opened = await openTranslationMemoryDatabase(options.factory);
	if (!opened.ok) return opened;
	return {
		ok: true,
		db: opened.db,
		store: new TranslationMemoryStore({
			db: opened.db,
			now: options.now,
			maxRecords: options.maxRecords,
			hash: options.hash,
		}),
	};
}

let defaultStorePromise:
	| Promise<TranslationMemoryStore | undefined>
	| undefined;

/** Lazily open the browser's default memory store. */
export function getDefaultTranslationMemoryStore(): Promise<
	TranslationMemoryStore | undefined
> {
	if (!defaultStorePromise) {
		defaultStorePromise = openTranslationMemoryStore().then((result) =>
			result.ok ? result.store : undefined,
		);
	}
	return defaultStorePromise;
}

/** Reset the lazy singleton in tests or after a storage policy change. */
export function resetDefaultTranslationMemoryStore(): void {
	defaultStorePromise = undefined;
}

/** Compatibility alias used by callers that prefer a shorter name. */
export const openMemoryStore = openTranslationMemoryStore;

/** Compatibility alias for the default lazy store. */
export const getMemoryStore = getDefaultTranslationMemoryStore;
