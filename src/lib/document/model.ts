/**
 * Document translation data model.
 *
 * Three shapes here, deliberately distinct:
 *
 * - `DocumentFormat` — the four accepted formats, which decides how a file is
 *   parsed and whether its layout can be rebuilt.
 * - `TextChunk` — one unit of translation, carrying the location it came from so
 *   its result can be written back to exactly that place.
 * - `DocumentTaskRecord` — everything a resumed task needs, stored as text.
 *
 * The source file itself is **not** part of the task record: it is large, it is
 * only needed for rebuilding, and it has a different lifetime. See `task-store.ts`.
 */

/** Accepted document formats. */
export const DOCUMENT_FORMATS = ["docx", "pdf", "pptx", "xlsx"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** Formats whose original layout can be preserved by replacing text in place. */
export const LAYOUT_PRESERVING_FORMATS: readonly DocumentFormat[] = [
	"docx",
	"pptx",
	"xlsx",
];

/** Formats where the delivered result is paired text rather than a rebuilt file. */
export function deliversTextOnly(format: DocumentFormat): boolean {
	return !LAYOUT_PRESERVING_FORMATS.includes(format);
}

/** Largest accepted file, in bytes. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Page count above which a document becomes an asynchronous task. */
export const TASK_PAGE_THRESHOLD = 50;

/** File size above which a document becomes an asynchronous task. */
export const TASK_BYTE_THRESHOLD = 2 * 1024 * 1024;

/** Largest text sent as one chunk, in characters. */
export const MAX_CHUNK_CHARACTERS = 2000;

/**
 * Where a chunk came from.
 *
 * Enough to write a result back without re-deriving anything: which part of the
 * package, which paragraph inside it, and which sentence inside that paragraph.
 * A part name is `undefined` for PDFs, where the unit is a page.
 */
export interface ChunkLocation {
	/** Package part the text came from, e.g. `word/document.xml`. */
	readonly part?: string;
	/** 1-based page number, for PDFs. */
	readonly page?: number;
	/** Index of the paragraph within its part or page. */
	readonly paragraph: number;
	/** Index of the sentence within its paragraph; 0 when the paragraph is whole. */
	readonly segment: number;
}

/** One unit of translation. */
export interface TextChunk {
	/** Stable within one run: `part:paragraph:segment` or `page:paragraph:segment`. */
	readonly id: string;
	readonly text: string;
	readonly location: ChunkLocation;
}

/** Result of parsing a document into translatable text. */
export interface ParsedDocument {
	readonly format: DocumentFormat;
	readonly chunks: readonly TextChunk[];
	/** Page count when known, used for the task threshold. */
	readonly pageCount?: number;
}

/** A chunk plus its result, as stored between runs. */
export interface TranslatedChunk {
	readonly chunk: TextChunk;
	/** Set once the chunk has a result, whether from the model or from memory. */
	readonly target?: string;
	/** Whether the result came from translation memory rather than the model. */
	readonly fromMemory?: boolean;
}

/** Task states. `failed` covers both an error and a user cancellation. */
export const TASK_STATES = [
	"queued",
	"processing",
	"succeeded",
	"failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** How a failed task ended, so a cancellation is not shown as an error. */
export const FAILURE_KINDS = ["error", "cancelled"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Everything needed to translate one document, stored as text. */
export interface DocumentTaskRecord {
	readonly id: string;
	readonly fileName: string;
	readonly format: DocumentFormat;
	/** Target language identifier, used in the delivered file name. */
	readonly targetLang: string;
	readonly sourceLang: string;
	/** Context that affects output; a change invalidates stored results. */
	readonly styleId: string;
	readonly state: TaskState;
	readonly failureKind?: FailureKind;
	/** Why it failed, for display. */
	readonly failureDetail?: string;
	readonly chunks: readonly TranslatedChunk[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** Count of chunks with a result. */
export function completedChunkCount(record: DocumentTaskRecord): number {
	return record.chunks.filter((entry) => entry.target !== undefined).length;
}

/** Whether every chunk has a result. */
export function isComplete(record: DocumentTaskRecord): boolean {
	return record.chunks.every((entry) => entry.target !== undefined);
}

/** Whether a task has ended, in any of the three ways it can end. */
export function isTerminal(state: TaskState): boolean {
	return state === "succeeded" || state === "failed";
}
