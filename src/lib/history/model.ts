/**
 * History record model and validation.
 *
 * Pure logic: no IndexedDB, no browser APIs. Everything that decides *what* a
 * record is lives here so it can be tested exhaustively without a database.
 *
 * The record deliberately has no field for a credential. Secret isolation is a
 * property of this shape rather than of a filter somewhere downstream: a value
 * that cannot be represented cannot leak into storage or an export.
 */

import {
	acceptInput,
	countCharacters,
	MAX_INPUT_CHARACTERS,
} from "../translation/result";

/** A stored translation record. */
export interface HistoryRecord {
	/** Stable identifier, assigned on insert. */
	readonly id: string;
	readonly sourceText: string;
	readonly targetText: string;
	/** The language the user asked for, which may be `auto`. */
	readonly sourceLang: string;
	readonly targetLang: string;
	/** Provider model id, for the user's own reference. */
	readonly model: string;
	/**
	 * Language actually used, after auto-detection resolved a concrete one.
	 *
	 * Kept separate from `sourceLang` so the interface can still show what the
	 * user selected while deduplication compares what actually happened.
	 */
	readonly detectedLang?: string;
	readonly favorite: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** Wall-clock duration of the translation, when known. */
	readonly durationMs?: number;
}

/** Fields required from a caller creating or updating a record. */
export interface HistoryRecordInput {
	readonly sourceText: string;
	readonly targetText: string;
	readonly sourceLang: string;
	readonly targetLang: string;
	readonly model: string;
	readonly detectedLang?: string;
	readonly durationMs?: number;
}

/** Result of validating an untrusted record (import path). */
export type ValidationResult =
	| { readonly ok: true; readonly record: HistoryRecordInput }
	| { readonly ok: false; readonly reason: string };

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * Normalize the source text used for deduplication.
 *
 * Whitespace differences are folded because the same sentence typed twice with
 * different trailing spaces is the same translation to a user. Case is *not*
 * folded: capitalisation can change meaning.
 */
export function normalizeForDedupe(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/**
 * Compute the deduplication key.
 *
 * Includes the language actually used (falling back to the requested source
 * language) and the target language. Deduplication is performed by an index on
 * this key, so the lookup is a point query rather than a scan.
 */
export function dedupeKey(input: {
	readonly sourceText: string;
	readonly sourceLang: string;
	readonly targetLang: string;
	readonly detectedLang?: string;
}): string {
	// Prefer the detected language so "auto → en" and "explicit en" collapse into
	// one record: from the user's point of view the same translation happened.
	const effectiveSource =
		input.detectedLang !== undefined && input.detectedLang !== ""
			? input.detectedLang
			: input.sourceLang;

	return [
		normalizeForDedupe(input.sourceText),
		effectiveSource,
		input.targetLang,
	].join("\u0000");
}

/** Fields the key is derived from, for building an index key path. */
export const DEDUPE_KEY_FIELDS = ["dedupeKey"] as const;

/**
 * Validate and normalize an untrusted record.
 *
 * Used by the import path. Source text over the input limit is truncated by the
 * existing rule rather than rejected, matching what the translation input does.
 */
export function validateRecord(raw: unknown): ValidationResult {
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, reason: "记录不是对象" };
	}

	const value = raw as Record<string, unknown>;

	if (!isNonEmptyString(value.sourceText))
		return { ok: false, reason: "缺少原文" };
	if (typeof value.targetText !== "string")
		return { ok: false, reason: "缺少译文" };
	if (!isNonEmptyString(value.sourceLang))
		return { ok: false, reason: "缺少源语言" };
	if (!isNonEmptyString(value.targetLang))
		return { ok: false, reason: "缺少目标语言" };

	// Truncate rather than reject: an over-long source is still a usable record.
	const accepted = acceptInput(value.sourceText);

	return {
		ok: true,
		record: {
			sourceText: accepted.text,
			targetText: value.targetText,
			sourceLang: value.sourceLang,
			targetLang: value.targetLang,
			model: typeof value.model === "string" ? value.model : "",
			...(isNonEmptyString(value.detectedLang) && {
				detectedLang: value.detectedLang,
			}),
			...(typeof value.durationMs === "number" &&
			Number.isFinite(value.durationMs)
				? { durationMs: value.durationMs }
				: {}),
		},
	};
}

/** Whether a stored record satisfies the shape the application expects. */
export function isHistoryRecord(raw: unknown): raw is HistoryRecord {
	if (typeof raw !== "object" || raw === null) return false;
	const value = raw as Record<string, unknown>;

	return (
		isNonEmptyString(value.id) &&
		typeof value.sourceText === "string" &&
		typeof value.targetText === "string" &&
		isNonEmptyString(value.sourceLang) &&
		isNonEmptyString(value.targetLang) &&
		typeof value.favorite === "boolean" &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number"
	);
}

/** Enforce the source-text limit on a value about to be stored. */
export function clampSourceText(text: string): string {
	return acceptInput(text).text;
}

/** Whether a source text is within the stored limit. */
export function isWithinLimit(text: string): boolean {
	return countCharacters(text) <= MAX_INPUT_CHARACTERS;
}

/**
 * Serializable form of a record, used for export.
 *
 * Written field by field rather than spread, so a field that somehow reached the
 * object cannot be exported by accident.
 */
export function toExportable(record: HistoryRecord): Record<string, unknown> {
	return {
		sourceText: record.sourceText,
		targetText: record.targetText,
		sourceLang: record.sourceLang,
		targetLang: record.targetLang,
		model: record.model,
		...(record.detectedLang !== undefined && {
			detectedLang: record.detectedLang,
		}),
		favorite: record.favorite,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.durationMs !== undefined && { durationMs: record.durationMs }),
	};
}
