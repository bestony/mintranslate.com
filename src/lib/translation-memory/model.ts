/**
 * Pure translation-memory model helpers.
 *
 * This module deliberately contains no browser APIs. Keeping validation,
 * normalization and segment pairing here makes the IndexedDB boundary small and
 * lets the controller use the same rules in browser and test environments.
 */

import { segmentTranslation } from "../translation/result";

export const MEMORY_ORIGINS = ["model", "user-edit", "import"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export interface LanguagePair {
	readonly sl: string;
	readonly tl: string;
}

/** Structural copy of the glossary provider contract. */
export type GlossaryVersionProvider = (pair: LanguagePair) => Promise<string>;

/** Context that participates in an exact memory key. */
export interface MemoryContext extends LanguagePair {
	readonly glossaryVersion: string;
	readonly styleId: string;
	readonly tier: string;
}

/** Public translation-memory record. */
export interface TranslationMemoryRecord extends MemoryContext {
	readonly id: string;
	readonly sourceText: string;
	readonly targetText: string;
	/** Hash of the normalized source and exact-key context. */
	readonly sourceHash: string;
	readonly origin: MemoryOrigin;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly hitCount: number;
	readonly lastHitAt?: number;
}

/** Short alias for consumers that use the generic term "memory record". */
export type MemoryRecord = TranslationMemoryRecord;

/** Input accepted by a single-record write. */
export interface TranslationMemoryInput extends Partial<MemoryContext> {
	readonly sourceText: string;
	readonly targetText: string;
	readonly origin?: MemoryOrigin;
	readonly id?: string;
	readonly createdAt?: number;
	readonly updatedAt?: number;
	readonly hitCount?: number;
	readonly lastHitAt?: number;
}

/** Defaults used when imports or older callers omit optional context fields. */
export const DEFAULT_MEMORY_CONTEXT: MemoryContext = {
	sl: "auto",
	tl: "",
	glossaryVersion: "none",
	styleId: "default",
	tier: "balanced",
};

/** Maximum number of source code points accepted by the translation input. */
export const MAX_MEMORY_SOURCE_CHARACTERS = 5000;

/** Maximum number of records retained by the store. */
export const DEFAULT_MEMORY_LIMIT = 20_000;

/** Normalize a value used for exact keys and text indexes. */
export function normalizeMemoryText(value: string): string {
	return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Normalize a value used for case-insensitive keyword matching. */
export function normalizeSearchText(value: string): string {
	return normalizeMemoryText(value).toLocaleLowerCase();
}

/** Count Unicode code points rather than UTF-16 code units. */
export function memoryCharacterCount(value: string): number {
	return Array.from(value).length;
}

/** Truncate source text without splitting a surrogate pair. */
export function clampMemorySourceText(value: string): string {
	const codePoints = Array.from(value);
	return codePoints.length <= MAX_MEMORY_SOURCE_CHARACTERS
		? value
		: codePoints.slice(0, MAX_MEMORY_SOURCE_CHARACTERS).join("");
}

/** Normalize caller input into a complete key context. */
export function normalizeMemoryContext(
	input: Partial<MemoryContext> = {},
): MemoryContext {
	return {
		sl: input.sl?.trim() || DEFAULT_MEMORY_CONTEXT.sl,
		tl: input.tl?.trim() || DEFAULT_MEMORY_CONTEXT.tl,
		glossaryVersion:
			input.glossaryVersion?.trim() || DEFAULT_MEMORY_CONTEXT.glossaryVersion,
		styleId: input.styleId?.trim() || DEFAULT_MEMORY_CONTEXT.styleId,
		tier: input.tier?.trim() || DEFAULT_MEMORY_CONTEXT.tier,
	};
}

/** Pair source and target segments, falling back to one whole-text pair. */
export function pairTranslationSegments(
	sourceText: string,
	targetText: string,
): readonly { sourceText: string; targetText: string }[] {
	const source = segmentTranslation(sourceText).map((segment) => segment.text);
	const target = segmentTranslation(targetText).map((segment) => segment.text);

	if (source.length > 0 && source.length === target.length) {
		return source.map((sourceSegment, index) => ({
			sourceText: sourceSegment,
			targetText: target[index] ?? "",
		}));
	}

	if (sourceText.trim() === "" || targetText.trim() === "") return [];
	return [{ sourceText: sourceText.trim(), targetText: targetText.trim() }];
}

/** A small, explicit validation result for untrusted imports. */
export type MemoryValidationResult =
	| { readonly ok: true; readonly input: TranslationMemoryInput }
	| { readonly ok: false; readonly reason: string };

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function isOrigin(value: unknown): value is MemoryOrigin {
	return (
		typeof value === "string" &&
		(MEMORY_ORIGINS as readonly string[]).includes(value)
	);
}

/** Validate a JSON/TMX record without accepting credentials or unknown fields. */
export function validateMemoryInput(raw: unknown): MemoryValidationResult {
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, reason: "记忆记录不是对象" };
	}

	const value = raw as Record<string, unknown>;
	if (!isNonEmptyString(value.sourceText)) {
		return { ok: false, reason: "缺少原文" };
	}
	if (typeof value.targetText !== "string") {
		return { ok: false, reason: "缺少译文" };
	}
	if (!isNonEmptyString(value.sl) || !isNonEmptyString(value.tl)) {
		return { ok: false, reason: "缺少语言对" };
	}

	const origin = isOrigin(value.origin) ? value.origin : "import";
	const sourceText = clampMemorySourceText(value.sourceText);
	const targetText = value.targetText;
	const optionalNumber = (candidate: unknown): number | undefined =>
		typeof candidate === "number" && Number.isFinite(candidate)
			? candidate
			: undefined;

	return {
		ok: true,
		input: {
			sourceText,
			targetText,
			sl: value.sl,
			tl: value.tl,
			glossaryVersion:
				typeof value.glossaryVersion === "string"
					? value.glossaryVersion
					: DEFAULT_MEMORY_CONTEXT.glossaryVersion,
			styleId:
				typeof value.styleId === "string"
					? value.styleId
					: DEFAULT_MEMORY_CONTEXT.styleId,
			tier:
				typeof value.tier === "string"
					? value.tier
					: DEFAULT_MEMORY_CONTEXT.tier,
			origin,
			...(isNonEmptyString(value.id) && { id: value.id }),
			...(optionalNumber(value.createdAt) !== undefined && {
				createdAt: optionalNumber(value.createdAt),
			}),
			...(optionalNumber(value.updatedAt) !== undefined && {
				updatedAt: optionalNumber(value.updatedAt),
			}),
			...(optionalNumber(value.hitCount) !== undefined && {
				hitCount: Math.max(0, Math.floor(optionalNumber(value.hitCount) ?? 0)),
			}),
			...(optionalNumber(value.lastHitAt) !== undefined && {
				lastHitAt: optionalNumber(value.lastHitAt),
			}),
		},
	};
}

/** Whitelist fields so internal index keys never enter exports. */
export function toExportableMemoryRecord(
	record: TranslationMemoryRecord,
): Record<string, unknown> {
	return {
		id: record.id,
		sourceText: record.sourceText,
		targetText: record.targetText,
		sl: record.sl,
		tl: record.tl,
		sourceHash: record.sourceHash,
		glossaryVersion: record.glossaryVersion,
		styleId: record.styleId,
		tier: record.tier,
		origin: record.origin,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		hitCount: record.hitCount,
		...(record.lastHitAt !== undefined && { lastHitAt: record.lastHitAt }),
	};
}
