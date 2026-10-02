/** Public glossary store: persistence, versions, matching and transfer. */

import { logger } from "../logger";
import {
	bumpGlossaryVersion,
	clearAllTerms,
	deleteTermById,
	findTermByKey,
	type GlossaryOpenResult,
	openGlossaryDatabase,
	putTerm,
	readAllTerms,
	readGlossaryVersion,
	readTermById,
	readTermsByPair,
	readTermsByTarget,
} from "./db";
import { GlossaryAutomaton } from "./matcher";
import {
	type ExportFormat,
	type GlossaryImportReport,
	type GlossaryMatch,
	type GlossaryTerm,
	type GlossaryTermInput,
	type GlossaryTermPatch,
	type ImportConflictStrategy,
	type LanguagePair,
	newTermId,
	normalizeLanguage,
	pairKey,
	termAppliesToPair,
	validateTermInput,
} from "./model";
import { parseGlossaryPayload, serializeGlossary } from "./transfer";

export type GlossaryResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

export type GlossaryWriteResult =
	| {
			readonly ok: true;
			readonly value: GlossaryTerm;
			readonly term: GlossaryTerm;
	  }
	| { readonly ok: false; readonly reason: string };

export interface GlossaryExportResult {
	readonly ok: true;
	readonly content: string;
	readonly format: ExportFormat;
	readonly count: number;
}

export interface GlossaryStoreOptions {
	readonly factory?: IDBFactory;
	readonly now?: () => number;
}

export interface GlossaryStore {
	open(): Promise<GlossaryOpenResult>;
	get(id: string): Promise<GlossaryResult<GlossaryTerm | undefined>>;
	read(id: string): Promise<GlossaryResult<GlossaryTerm | undefined>>;
	list(pair?: LanguagePair): Promise<GlossaryResult<readonly GlossaryTerm[]>>;
	getAll(pair?: LanguagePair): Promise<GlossaryResult<readonly GlossaryTerm[]>>;
	query(pair?: LanguagePair): Promise<GlossaryResult<readonly GlossaryTerm[]>>;
	add(input: GlossaryTermInput): Promise<GlossaryWriteResult>;
	create(input: GlossaryTermInput): Promise<GlossaryWriteResult>;
	update(id: string, patch: GlossaryTermPatch): Promise<GlossaryWriteResult>;
	remove(id: string): Promise<GlossaryResult<boolean>>;
	delete(id: string): Promise<GlossaryResult<boolean>>;
	clear(pair?: LanguagePair): Promise<GlossaryResult<number>>;
	bulkAdd(inputs: readonly GlossaryTermInput[]): Promise<GlossaryImportReport>;
	addMany(inputs: readonly GlossaryTermInput[]): Promise<GlossaryImportReport>;
	bulkUpsert(
		inputs: readonly GlossaryTermInput[],
		strategy?: ImportConflictStrategy,
	): Promise<GlossaryImportReport>;
	import(
		payload: string,
		options?: {
			readonly format?: ExportFormat;
			readonly conflict?: ImportConflictStrategy;
		},
	): Promise<GlossaryResult<GlossaryImportReport>>;
	importData(
		payload: string,
		options?: {
			readonly format?: ExportFormat;
			readonly conflict?: ImportConflictStrategy;
		},
	): Promise<GlossaryResult<GlossaryImportReport>>;
	export(
		format?: ExportFormat,
		pair?: LanguagePair,
	): Promise<GlossaryResult<GlossaryExportResult>>;
	exportData(
		format?: ExportFormat,
		pair?: LanguagePair,
	): Promise<GlossaryResult<GlossaryExportResult>>;
	getVersion(pair: LanguagePair): Promise<string>;
	match(text: string, pair: LanguagePair): Promise<readonly GlossaryMatch[]>;
	matchTerms(
		text: string,
		pair: LanguagePair,
	): Promise<readonly GlossaryMatch[]>;
}

function nowMs(clock: () => number): number {
	const value = clock();
	return Number.isFinite(value) ? value : Date.now();
}

function emptyImportReport(
	errors: readonly string[] = [],
): GlossaryImportReport {
	return {
		inserted: 0,
		updated: 0,
		skipped: 0,
		conflicts: 0,
		invalid: 0,
		errors,
	};
}

function resultError<T>(reason: string): GlossaryResult<T> {
	return { ok: false, reason };
}

const ALL_SOURCE_VERSION = "*";

async function bumpTermVersions(
	database: IDBDatabase,
	term: Pick<GlossaryTerm, "sl" | "tl">,
	clock: () => number,
): Promise<void> {
	await bumpGlossaryVersion(database, term, nowMs(clock));
	// A concrete source pair is included in an `auto` query; an auto term is
	// included in every concrete source pair. The target aggregate lets the
	// auto-query cache invalidate when any source language changes.
	await bumpGlossaryVersion(
		database,
		{ sl: ALL_SOURCE_VERSION, tl: term.tl },
		nowMs(clock),
	);
}

async function versionForPair(
	database: IDBDatabase,
	pair: LanguagePair,
): Promise<string> {
	const targetAggregate = await readGlossaryVersion(database, {
		sl: ALL_SOURCE_VERSION,
		tl: pair.tl,
	});
	if (normalizeLanguage(pair.sl) === "auto") {
		return targetAggregate;
	}
	const exact = await readGlossaryVersion(database, pair);
	const wildcard = await readGlossaryVersion(database, {
		sl: "auto",
		tl: pair.tl,
	});
	if (exact === "0" && wildcard === "0" && targetAggregate === "0") return "0";
	return `${exact}|${wildcard}|${targetAggregate}`;
}

/** Create an independent store, useful for tests and isolated consumers. */
export function createGlossaryStore(
	options: GlossaryStoreOptions = {},
): GlossaryStore {
	const clock = options.now ?? Date.now;
	let databasePromise: Promise<GlossaryOpenResult> | undefined;
	const automata = new Map<string, GlossaryAutomaton>();

	async function open(): Promise<GlossaryOpenResult> {
		if (databasePromise === undefined)
			databasePromise = openGlossaryDatabase(options.factory);
		return databasePromise;
	}

	async function database(): Promise<GlossaryResult<IDBDatabase>> {
		const opened = await open();
		return opened.ok
			? { ok: true, value: opened.db }
			: resultError(opened.reason);
	}

	function invalidate(pair: LanguagePair): void {
		const prefix = `${pairKey(pair)}:`;
		for (const key of automata.keys()) {
			if (key.startsWith(prefix)) automata.delete(key);
		}
	}

	async function add(input: GlossaryTermInput): Promise<GlossaryWriteResult> {
		const validated = validateTermInput(input);
		if (!validated.ok) return validated;
		const opened = await database();
		if (!opened.ok) return opened;
		const existing = await findTermByKey(opened.value, validated.input);
		if (existing !== undefined)
			return { ok: false, reason: "同一语言对中已存在相同源词" };

		const at = nowMs(clock);
		const term: GlossaryTerm = {
			id: newTermId(),
			...validated.input,
			createdAt: at,
			updatedAt: at,
		};
		const saved = await putTerm(opened.value, term);
		if (!saved.ok) return saved;
		await bumpTermVersions(opened.value, term, clock);
		invalidate(term);
		logger.info("glossary.term.added", { priority: term.priority });
		return { ok: true, value: term, term };
	}

	async function update(
		id: string,
		patch: GlossaryTermPatch,
	): Promise<GlossaryWriteResult> {
		const opened = await database();
		if (!opened.ok) return opened;
		const current = await readTermById(opened.value, id);
		if (current === undefined) return { ok: false, reason: "术语不存在" };
		const validated = validateTermInput({ ...current, ...patch });
		if (!validated.ok) return validated;
		const collision = await findTermByKey(opened.value, validated.input);
		if (collision !== undefined && collision.id !== id)
			return { ok: false, reason: "同一语言对中已存在相同源词" };

		const at = nowMs(clock);
		const term: GlossaryTerm = {
			id,
			...validated.input,
			createdAt: current.createdAt,
			updatedAt: at,
		};
		const saved = await putTerm(opened.value, term);
		if (!saved.ok) return saved;
		await bumpTermVersions(opened.value, current, clock);
		if (pairKey(current) !== pairKey(term))
			await bumpTermVersions(opened.value, term, clock);
		invalidate(current);
		invalidate(term);
		logger.info("glossary.term.updated", { priority: term.priority });
		return { ok: true, value: term, term };
	}

	async function remove(id: string): Promise<GlossaryResult<boolean>> {
		const opened = await database();
		if (!opened.ok) return opened;
		const current = await readTermById(opened.value, id);
		if (current === undefined) return { ok: true, value: false };
		const removed = await deleteTermById(opened.value, id);
		if (!removed.ok) return removed;
		await bumpTermVersions(opened.value, current, clock);
		invalidate(current);
		logger.info("glossary.term.deleted", {});
		return { ok: true, value: true };
	}

	async function list(
		pair?: LanguagePair,
	): Promise<GlossaryResult<readonly GlossaryTerm[]>> {
		const opened = await database();
		if (!opened.ok) return opened;
		try {
			if (pair === undefined)
				return { ok: true, value: await readAllTerms(opened.value) };
			const source = normalizeLanguage(pair.sl);
			const terms =
				source === "auto"
					? await readTermsByTarget(opened.value, pair.tl)
					: [
							...(await readTermsByPair(opened.value, pair)),
							...(await readTermsByPair(opened.value, {
								sl: "auto",
								tl: pair.tl,
							})),
						];
			const unique = new Map<string, GlossaryTerm>();
			for (const term of terms) {
				if (termAppliesToPair(term, pair)) unique.set(term.id, term);
			}
			return { ok: true, value: [...unique.values()] };
		} catch (error) {
			return resultError(`读取术语失败：${String(error)}`);
		}
	}

	async function clear(pair?: LanguagePair): Promise<GlossaryResult<number>> {
		const opened = await database();
		if (!opened.ok) return opened;
		const listed = await list(pair);
		if (!listed.ok) return listed;
		if (pair === undefined) {
			const all = await readAllTerms(opened.value);
			const cleared = await clearAllTerms(opened.value);
			if (!cleared.ok) return cleared;
			for (const term of all) invalidate(term);
			for (const term of all) await bumpTermVersions(opened.value, term, clock);
			return { ok: true, value: all.length };
		}
		let count = 0;
		for (const term of listed.value) {
			const removed = await remove(term.id);
			if (removed.ok && removed.value) count += 1;
		}
		return { ok: true, value: count };
	}

	async function bulkUpsert(
		inputs: readonly GlossaryTermInput[],
		strategy: ImportConflictStrategy = "skip",
	): Promise<GlossaryImportReport> {
		let report = emptyImportReport();
		const errors = [...report.errors];
		for (const input of inputs) {
			const validated = validateTermInput(input);
			if (!validated.ok) {
				report = { ...report, invalid: report.invalid + 1 };
				if (errors.length < 10) errors.push(validated.reason);
				continue;
			}
			const opened = await database();
			if (!opened.ok) {
				if (errors.length < 10) errors.push(opened.reason);
				report = { ...report, invalid: report.invalid + 1 };
				continue;
			}
			const existing = await findTermByKey(opened.value, validated.input);
			if (existing !== undefined) {
				report = { ...report, conflicts: report.conflicts + 1 };
				if (strategy === "skip") {
					report = { ...report, skipped: report.skipped + 1 };
					continue;
				}
				const updated = await update(existing.id, validated.input);
				if (!updated.ok) {
					if (errors.length < 10) errors.push(updated.reason);
					continue;
				}
				report = { ...report, updated: report.updated + 1 };
				continue;
			}
			const added = await add(validated.input);
			if (!added.ok) {
				if (errors.length < 10) errors.push(added.reason);
				continue;
			}
			report = { ...report, inserted: report.inserted + 1 };
		}
		return { ...report, errors };
	}

	async function importPayload(
		payload: string,
		options: {
			readonly format?: ExportFormat;
			readonly conflict?: ImportConflictStrategy;
		} = {},
	): Promise<GlossaryResult<GlossaryImportReport>> {
		const parsed = parseGlossaryPayload(payload, options.format);
		if (!parsed.ok) return parsed;
		const report = await bulkUpsert(
			parsed.records as readonly GlossaryTermInput[],
			options.conflict ?? "skip",
		);
		return {
			ok: true,
			value: {
				...report,
				errors: [...parsed.errors, ...report.errors].slice(0, 10),
			},
		};
	}

	async function exportPayload(
		format: ExportFormat = "json",
		pair?: LanguagePair,
	): Promise<GlossaryResult<GlossaryExportResult>> {
		const listed = await list(pair);
		if (!listed.ok) return listed;
		return {
			ok: true,
			value: {
				ok: true,
				content: serializeGlossary(listed.value, format),
				format,
				count: listed.value.length,
			},
		};
	}

	async function getVersion(pair: LanguagePair): Promise<string> {
		const opened = await database();
		if (!opened.ok) return "unavailable";
		try {
			return await versionForPair(opened.value, pair);
		} catch {
			return "unavailable";
		}
	}

	async function matchTerms(
		text: string,
		pair: LanguagePair,
	): Promise<readonly GlossaryMatch[]> {
		const started =
			typeof performance === "undefined" ? Date.now() : performance.now();
		const version = await getVersion(pair);
		const listed = await list(pair);
		if (!listed.ok) return [];
		const cacheKey = `${pairKey(pair)}:${version}`;
		let automaton = automata.get(cacheKey);
		if (automaton === undefined) {
			const rebuildStarted =
				typeof performance === "undefined" ? Date.now() : performance.now();
			automaton = new GlossaryAutomaton(listed.value, pair);
			automata.set(cacheKey, automaton);
			const rebuildMs =
				(typeof performance === "undefined" ? Date.now() : performance.now()) -
				rebuildStarted;
			logger.debug("glossary.automaton.rebuilt", {
				termCount: automaton.patternCount,
				rebuildMs,
			});
		}
		const matches = automaton.match(text);
		const elapsedMs =
			(typeof performance === "undefined" ? Date.now() : performance.now()) -
			started;
		logger.debug("glossary.match.done", {
			matchCount: matches.length,
			textLength: text.length,
			elapsedMs,
		});
		return matches;
	}

	return {
		open,
		get: async (id) => {
			const opened = await database();
			if (!opened.ok) return opened;
			try {
				return { ok: true, value: await readTermById(opened.value, id) };
			} catch (error) {
				return resultError(`读取术语失败：${String(error)}`);
			}
		},
		list,
		read: async (id) => {
			const opened = await database();
			if (!opened.ok) return opened;
			try {
				return { ok: true, value: await readTermById(opened.value, id) };
			} catch (error) {
				return resultError(`读取术语失败：${String(error)}`);
			}
		},
		getAll: list,
		query: list,
		add,
		create: add,
		update,
		remove,
		delete: remove,
		clear,
		bulkAdd: (inputs) => bulkUpsert(inputs, "skip"),
		addMany: (inputs) => bulkUpsert(inputs, "skip"),
		bulkUpsert,
		import: importPayload,
		importData: importPayload,
		export: exportPayload,
		exportData: exportPayload,
		getVersion,
		match: matchTerms,
		matchTerms,
	};
}

export const glossaryStore = createGlossaryStore();
/** Short public alias for consumers that import a singleton named `store`. */
export const store = glossaryStore;

export const getGlossaryVersion = (pair: LanguagePair): Promise<string> =>
	glossaryStore.getVersion(pair);

export const matchTerms = (
	text: string,
	pair: LanguagePair,
): Promise<readonly GlossaryMatch[]> => glossaryStore.matchTerms(text, pair);
export const matchGlossary = matchTerms;

export const getTerm = (id: string) => glossaryStore.get(id);
export const listTerms = (pair?: LanguagePair) => glossaryStore.list(pair);
export const addTerm = (input: GlossaryTermInput) => glossaryStore.add(input);
export const createTerm = addTerm;
export const updateTerm = (id: string, patch: GlossaryTermPatch) =>
	glossaryStore.update(id, patch);
export const deleteTerm = (id: string) => glossaryStore.remove(id);
export const removeTerm = deleteTerm;
export const clearTerms = (pair?: LanguagePair) => glossaryStore.clear(pair);
export const bulkAddTerms = (inputs: readonly GlossaryTermInput[]) =>
	glossaryStore.bulkAdd(inputs);
export const bulkUpsertTerms = (
	inputs: readonly GlossaryTermInput[],
	strategy: ImportConflictStrategy = "skip",
) => glossaryStore.bulkUpsert(inputs, strategy);
export const importTerms = (
	payload: string,
	options?: {
		readonly format?: ExportFormat;
		readonly conflict?: ImportConflictStrategy;
	},
) => glossaryStore.import(payload, options);
export const exportTerms = (
	format: ExportFormat = "json",
	pair?: LanguagePair,
) => glossaryStore.export(format, pair);
