/** Pure glossary types, validation and serialization boundaries. */

export interface LanguagePair {
	readonly sl: string;
	readonly tl: string;
}

/** Opaque version provider consumed by translation-memory. */
export type GlossaryVersionProvider = (pair: LanguagePair) => Promise<string>;

export interface GlossaryTerm {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly sl: string;
	readonly tl: string;
	readonly caseSensitive: boolean;
	readonly note: string;
	readonly priority: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface GlossaryTermInput {
	readonly source: string;
	readonly target: string;
	readonly sl: string;
	readonly tl: string;
	readonly caseSensitive?: boolean;
	readonly note?: string;
	readonly priority?: number;
}

export type NormalizedGlossaryTermInput = Omit<
	GlossaryTermInput,
	"caseSensitive" | "note" | "priority"
> & {
	readonly caseSensitive: boolean;
	readonly note: string;
	readonly priority: number;
};

export interface GlossaryTermPatch {
	readonly source?: string;
	readonly target?: string;
	readonly sl?: string;
	readonly tl?: string;
	readonly caseSensitive?: boolean;
	readonly note?: string;
	readonly priority?: number;
}

export type GlossaryValidationResult =
	| { readonly ok: true; readonly input: NormalizedGlossaryTermInput }
	| { readonly ok: false; readonly reason: string };

export interface GlossaryMatch {
	readonly term: GlossaryTerm;
	/** UTF-16 start offset in the input text. */
	readonly start: number;
	/** UTF-16 exclusive end offset in the input text. */
	readonly end: number;
	/** Alias for `start`, useful to callers that use search terminology. */
	readonly index: number;
	/** Optional aliases for consumers that use range-search terminology. */
	readonly position?: number;
	readonly matchedText?: string;
	readonly source: string;
	readonly target: string;
	readonly priority: number;
}

export type ImportConflictStrategy = "skip" | "overwrite";

export interface GlossaryImportReport {
	readonly inserted: number;
	readonly updated: number;
	readonly skipped: number;
	readonly conflicts: number;
	readonly invalid: number;
	readonly errors: readonly string[];
}

export type ExportFormat = "csv" | "json";

/** Keep public text bounded without imposing the translation input limit. */
export const MAX_GLOSSARY_FIELD_LENGTH = 10_000;

const LATIN_LANGUAGE_BASES = new Set([
	"en",
	"fr",
	"de",
	"es",
	"pt",
	"it",
	"nl",
	"sv",
	"da",
	"no",
	"pl",
	"cs",
	"sk",
	"tr",
	"vi",
	"id",
	"ms",
	"ro",
	"hu",
	"fi",
	"et",
	"lv",
	"lt",
]);

/** Canonicalize language codes only for comparisons and index keys. */
export function normalizeLanguage(value: string): string {
	return value.trim().toLowerCase();
}

/** A stable key for a language pair. */
export function pairKey(pair: LanguagePair): string {
	return `${normalizeLanguage(pair.sl)}\u0000${normalizeLanguage(pair.tl)}`;
}

/** Whether a language is one of the CJK families without word boundaries. */
export function isCjkLanguage(language: string): boolean {
	const base = normalizeLanguage(language).split("-")[0];
	return base === "zh" || base === "ja" || base === "ko";
}

/** Whether a language normally uses Latin word boundaries. */
export function isLatinLanguage(language: string): boolean {
	const base = normalizeLanguage(language).split("-")[0];
	return LATIN_LANGUAGE_BASES.has(base);
}

/** Default matching sensitivity for a source language. */
export function defaultCaseSensitive(language: string): boolean {
	// Case folding is harmless for scripts without case and gives users the
	// predictable default of matching a term regardless of input casing.
	void language;
	return false;
}

/** Normalize a source for identity and index lookup. */
export function normalizeSource(source: string): string {
	return source.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable identity for a term, independent of its generated id. */
export function termKey(
	input: Pick<GlossaryTerm, "source" | "sl" | "tl">,
): string {
	return `${normalizeLanguage(input.sl)}\u0000${normalizeLanguage(input.tl)}\u0000${normalizeSource(input.source)}`;
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function boundedText(value: string, field: string): string | undefined {
	if (value.length > MAX_GLOSSARY_FIELD_LENGTH)
		return `${field} 超过 ${MAX_GLOSSARY_FIELD_LENGTH} 个字符`;
	return undefined;
}

/** Validate and normalize untrusted term input. */
export function validateTermInput(raw: unknown): GlossaryValidationResult {
	if (typeof raw !== "object" || raw === null)
		return { ok: false, reason: "术语不是对象" };

	const value = raw as Record<string, unknown>;
	if (!isNonEmptyText(value.source)) return { ok: false, reason: "缺少源词" };
	if (!isNonEmptyText(value.target)) return { ok: false, reason: "缺少译词" };
	if (!isNonEmptyText(value.sl)) return { ok: false, reason: "缺少源语言" };
	if (!isNonEmptyText(value.tl)) return { ok: false, reason: "缺少目标语言" };

	const source = value.source.trim().replace(/\s+/g, " ");
	const target = value.target.trim();
	const sl = value.sl.trim();
	const tl = value.tl.trim();
	if (normalizeLanguage(tl) === "auto")
		return { ok: false, reason: "目标语言不能是 auto" };
	for (const [field, text] of [
		["源词", source],
		["译词", target],
		["备注", typeof value.note === "string" ? value.note : ""],
	] as const) {
		const error = boundedText(text, field);
		if (error !== undefined) return { ok: false, reason: error };
	}

	if (
		typeof value.caseSensitive !== "undefined" &&
		typeof value.caseSensitive !== "boolean"
	) {
		return { ok: false, reason: "caseSensitive 必须是布尔值" };
	}

	const priority = value.priority === undefined ? 0 : value.priority;
	if (
		typeof priority !== "number" ||
		!Number.isFinite(priority) ||
		!Number.isInteger(priority)
	) {
		return { ok: false, reason: "priority 必须是有限整数" };
	}

	return {
		ok: true,
		input: {
			source,
			target,
			sl,
			tl,
			caseSensitive:
				value.caseSensitive === undefined
					? defaultCaseSensitive(sl)
					: value.caseSensitive,
			note: typeof value.note === "string" ? value.note.trim() : "",
			priority,
		},
	};
}

/** Validate a complete stored term, including its generated metadata. */
export function validateStoredTerm(
	raw: unknown,
):
	| { readonly ok: true; readonly term: GlossaryTerm }
	| { readonly ok: false; readonly reason: string } {
	if (typeof raw !== "object" || raw === null)
		return { ok: false, reason: "术语不是对象" };
	const value = raw as Record<string, unknown>;
	const input = validateTermInput(value);
	if (!input.ok) return input;
	if (!isNonEmptyText(value.id)) return { ok: false, reason: "缺少术语 id" };
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt))
		return { ok: false, reason: "createdAt 无效" };
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt))
		return { ok: false, reason: "updatedAt 无效" };

	return {
		ok: true,
		term: {
			id: value.id,
			...input.input,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		},
	};
}

/** Explicit export shape: no storage-only fields can escape. */
export function toExportableTerm(term: GlossaryTerm): Record<string, unknown> {
	return {
		source: term.source,
		target: term.target,
		sl: term.sl,
		tl: term.tl,
		caseSensitive: term.caseSensitive,
		note: term.note,
		priority: term.priority,
		createdAt: term.createdAt,
		updatedAt: term.updatedAt,
	};
}

/** Generate an id without requiring a browser crypto implementation. */
export function newTermId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
		return crypto.randomUUID();
	return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Whether a term can be used for the requested language pair. */
export function termAppliesToPair(
	term: Pick<GlossaryTerm, "sl" | "tl">,
	pair: LanguagePair,
): boolean {
	const termTarget = normalizeLanguage(term.tl);
	const requestedTarget = normalizeLanguage(pair.tl);
	if (termTarget !== requestedTarget) return false;

	const termSource = normalizeLanguage(term.sl);
	const requestedSource = normalizeLanguage(pair.sl);
	// Before detection resolves a concrete source, only an explicit wildcard is
	// safe to apply. Once a source is known, the wildcard applies alongside the
	// language-specific entries.
	if (requestedSource === "auto") return termSource === "auto";
	return termSource === "auto" || termSource === requestedSource;
}
