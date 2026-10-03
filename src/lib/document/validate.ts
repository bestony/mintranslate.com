/**
 * Document acceptance rules.
 *
 * Pure functions over a file's metadata, so the decision table is testable and a
 * rejected file is never opened. The three rejection reasons are kept distinct
 * because they need different user action: an unsupported format means "use
 * another tool", an oversized file means "shrink it", and an unparsable file means
 * "this file is damaged" — collapsing them into one message would hide which.
 */

import {
	DOCUMENT_FORMATS,
	type DocumentFormat,
	MAX_DOCUMENT_BYTES,
	TASK_BYTE_THRESHOLD,
	TASK_PAGE_THRESHOLD,
} from "./model";

/** What validation needs to know about a candidate file. */
export interface DocumentCandidate {
	readonly name: string;
	/** Browser-reported MIME type; may be empty. */
	readonly type: string;
	readonly size: number;
}

/** Accepted, or rejected with a reason and its kind. */
export type DocumentValidation =
	| { readonly ok: true; readonly format: DocumentFormat }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly kind: "format" | "size" | "empty";
	  };

/** Extension without the dot, lower-cased. */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether a string names one of the accepted formats. */
export function isDocumentFormat(value: string): value is DocumentFormat {
	return (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

/** Bytes as a short human-readable string. */
export function describeBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(0)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}

/** The accepted formats, for messages. */
const FORMAT_LIST = DOCUMENT_FORMATS.map((format) => `.${format}`).join("、");

/**
 * Decide whether a file may be processed.
 *
 * Format is decided by **extension**, not by the reported MIME type: the accepted
 * set is defined in terms of extensions in the requirements, and browsers disagree
 * about the MIME types for these formats (`.docx` is variously reported as
 * `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, as
 * `application/zip`, or as nothing at all). Using the MIME type would reject valid
 * files on some systems and accept invalid ones on others.
 */
export function validateDocument(
	candidate: DocumentCandidate,
): DocumentValidation {
	if (candidate.size === 0) {
		return { ok: false, kind: "empty", reason: "该文件是空的，无法读取内容。" };
	}

	const extension = extensionOf(candidate.name);
	if (!isDocumentFormat(extension)) {
		return {
			ok: false,
			kind: "format",
			reason: `不支持的文档格式。只接受 ${FORMAT_LIST}，该文件是「${
				extension === "" ? "无扩展名" : `.${extension}`
			}」。`,
		};
	}

	if (candidate.size > MAX_DOCUMENT_BYTES) {
		return {
			ok: false,
			kind: "size",
			reason: `文档过大：${describeBytes(candidate.size)}，上限为 ${describeBytes(
				MAX_DOCUMENT_BYTES,
			)}。`,
		};
	}

	return { ok: true, format: extension };
}

/**
 * Reason for a file that passed validation but could not be parsed.
 *
 * Separate from the validation kinds: by this point the format and size were
 * acceptable, so saying "unsupported format" would misdirect the user.
 */
export function unparsableReason(fileName: string): string {
	return `${fileName} 的内容无法按 ${extensionOf(fileName)} 格式解析，文件可能已损坏或并非该格式。`;
}

/** Why a document becomes an asynchronous task. */
export type TaskTrigger = "pages" | "bytes" | "none";

/**
 * Whether a document should be handled as a task.
 *
 * Reported as the reason rather than a boolean so the interface can say *why* a
 * document became a task, which is otherwise unexplained behaviour.
 */
export function taskTrigger(options: {
	readonly size: number;
	readonly pageCount?: number;
}): TaskTrigger {
	if (
		options.pageCount !== undefined &&
		options.pageCount > TASK_PAGE_THRESHOLD
	) {
		return "pages";
	}
	if (options.size > TASK_BYTE_THRESHOLD) return "bytes";
	return "none";
}

/** Thresholds, for the interface to state. */
export const TASK_THRESHOLDS = {
	pages: TASK_PAGE_THRESHOLD,
	bytes: TASK_BYTE_THRESHOLD,
} as const;

/** User-facing explanation shown whenever document processing is started. */
export function taskThresholdNotice(): string {
	return `超过 ${TASK_PAGE_THRESHOLD} 页或 ${describeBytes(
		TASK_BYTE_THRESHOLD,
	)} 的文档会转为可续传任务；较小文档同样显示进度并支持取消。`;
}
