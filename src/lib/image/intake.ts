/**
 * Intake decisions for the three image entry points.
 *
 * Drag-and-drop, the file picker and paste all end up with "some files", but each
 * arrives in a different DOM shape. Normalising them here — into plain candidates
 * — keeps the decision table testable without a DOM and leaves the component with
 * nothing to decide.
 *
 * Nothing in this module reads file content: every decision is made on name, type
 * and size, so a rejected file is never opened.
 */

/** The file-like shape a browser hands over. */
export interface FileLike {
	readonly name: string;
	readonly type: string;
	readonly size: number;
}

/** A clipboard entry, structurally. */
export interface ClipboardItemLike {
	readonly kind: string;
	readonly type: string;
	getAsFile?: () => FileLike | null;
}

/** What a drop or selection produced. */
export interface IntakeResult {
	/** Candidates in the order received. */
	readonly candidates: readonly FileLike[];
	/** True when the event carried no file at all. */
	readonly empty: boolean;
}

/** Normalise a `FileList`-like collection. */
export function candidatesFromFiles(
	files: ArrayLike<FileLike> | undefined,
): IntakeResult {
	if (files === undefined || files.length === 0) {
		return { candidates: [], empty: true };
	}

	const candidates = Array.from(files);
	return { candidates, empty: candidates.length === 0 };
}

/**
 * Pull the first image out of clipboard items.
 *
 * A paste can carry text, an image, or both. Text is ignored so that pasting text
 * into the mode does not start an image translation, and so that a paste with both
 * still prefers the image the user copied.
 */
export function imageFromClipboard(
	items: readonly ClipboardItemLike[] | undefined,
): FileLike | undefined {
	if (items === undefined) return undefined;

	for (const item of items) {
		if (item.kind !== "file") continue;
		if (!item.type.startsWith("image/")) continue;

		const file = item.getAsFile?.();
		if (file !== undefined && file !== null) return file;
	}

	return undefined;
}

/** Whether a paste event carries anything this mode should act on. */
export function clipboardHasImage(
	items: readonly ClipboardItemLike[] | undefined,
): boolean {
	return imageFromClipboard(items) !== undefined;
}

/** Visual states the drop target can be in. */
export const DROP_STATES = ["idle", "active", "invalid"] as const;
export type DropState = (typeof DROP_STATES)[number];

/** Why the target is in its current state, for the accessible description. */
export interface DropStateView {
	readonly state: DropState;
	/** Short instruction or reason, always present so the state is not colour-only. */
	readonly message: string;
}

/**
 * Decide the drop target's state.
 *
 * `invalid` is a distinct state rather than a variant of `active` because the two
 * mean opposite things ("you can drop this" versus "you cannot"), and the
 * requirement is that they be distinguishable without relying on colour.
 */
export function dropStateView(
	dragging: boolean,
	hasRejectedItem: boolean,
): DropStateView {
	if (!dragging) {
		return { state: "idle", message: "把图片拖到这里，或点击选择文件" };
	}
	if (hasRejectedItem) {
		return {
			state: "invalid",
			message: "拖入的内容不是可接受的图片，只接受 jpg、jpeg、png、webp",
		};
	}
	return { state: "active", message: "松开即可加入这张图片" };
}

/**
 * Whether a drag event carries files we might accept.
 *
 * Used during `dragover`, where reading the actual file list is not permitted —
 * only the item *types* are available.
 */
export function dragLooksAcceptable(
	types: readonly string[] | undefined,
): boolean {
	if (types === undefined) return false;
	return Array.from(types).includes("Files");
}
