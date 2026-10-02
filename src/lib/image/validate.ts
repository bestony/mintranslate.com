/**
 * Image acceptance rules.
 *
 * Pure functions over the file's metadata, so the decision table can be verified
 * without a browser and without decoding anything. The rules matter because a
 * rejection here is the cheapest possible outcome: nothing is read, decoded or
 * sent.
 *
 * Type detection is deliberate. A browser reports a MIME type when it recognises
 * the extension, and reports an empty string when it does not — so an empty type
 * is not evidence of a bad file, and a present-but-unsupported type *is*
 * evidence. The extension is only consulted in the first case.
 */

import {
	ACCEPTED_IMAGE_EXTENSIONS,
	ACCEPTED_IMAGE_MIME_TYPES,
	MAX_IMAGE_BYTES,
} from "./model";

/** What validation needs to know about a candidate file. */
export interface ImageCandidate {
	readonly name: string;
	/** Browser-reported MIME type; may be empty. */
	readonly type: string;
	/** Size in bytes. */
	readonly size: number;
}

/** Accepted, or rejected with a reason that names what to change. */
export type ValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/** Human-readable list of accepted formats, for messages. */
const FORMAT_LIST = "jpg、jpeg、png、webp";

/** Lower-cased extension including the dot, or an empty string. */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Whether the reported MIME type is one of the accepted ones. */
function hasAcceptedType(type: string): boolean {
	return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(
		type.toLowerCase(),
	);
}

/** Format decision, which needs both signals to judge. */
function formatAccepted(candidate: ImageCandidate): boolean {
	const type = candidate.type.trim();
	if (type !== "") return hasAcceptedType(type);
	// No MIME type: fall back to the extension. A file named `x.jpg` from a system
	// that did not identify it is still a file the user means to translate.
	return (ACCEPTED_IMAGE_EXTENSIONS as readonly string[]).includes(
		extensionOf(candidate.name),
	);
}

/** Bytes as a short human-readable string, for messages. */
export function describeBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(0)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Decide whether a file may be processed.
 *
 * Format is checked before size so the message names the more fundamental
 * problem when both apply: telling someone their GIF is too large would be
 * misleading, since shrinking it would not make it acceptable.
 */
export function validateImageCandidate(
	candidate: ImageCandidate,
): ValidationResult {
	if (!formatAccepted(candidate)) {
		return {
			ok: false,
			reason: `不支持的图片格式。只接受 ${FORMAT_LIST}，该文件是「${
				candidate.type.trim() || extensionOf(candidate.name) || "未知类型"
			}」。`,
		};
	}

	if (candidate.size > MAX_IMAGE_BYTES) {
		return {
			ok: false,
			reason: `图片过大：${describeBytes(candidate.size)}，上限为 ${describeBytes(
				MAX_IMAGE_BYTES,
			)}。请压缩后重试。`,
		};
	}

	// A zero-byte file is not an image whatever it is named.
	if (candidate.size === 0) {
		return { ok: false, reason: "该文件是空的，无法读取图片内容。" };
	}

	return { ok: true };
}
