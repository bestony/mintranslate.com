/**
 * Image translation data model.
 *
 * Two shapes live here and they are deliberately separate:
 *
 * - `AcceptedImage` — what the pipeline carries between stages. It holds bytes,
 *   never a URL or a file handle, so nothing here can outlive the session or be
 *   persisted by accident.
 * - `ImageRegion` — one recognised text region. `box` is absent when the model
 *   gave no usable position, which is a normal case and not an error.
 */

/** Image types the application accepts. */
export const ACCEPTED_IMAGE_MIME_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
] as const;

export type AcceptedImageMimeType = (typeof ACCEPTED_IMAGE_MIME_TYPES)[number];

/** File extensions accepted when a file carries no MIME type. */
export const ACCEPTED_IMAGE_EXTENSIONS = [
	".jpg",
	".jpeg",
	".png",
	".webp",
] as const;

/** Largest accepted file, in bytes. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Longest edge allowed in the image sent to the model, in pixels. */
export const MAX_SENT_EDGE_PX = 2048;

/** Largest image size allowed in the image sent to the model, in bytes. */
export const MAX_SENT_BYTES = 4 * 1024 * 1024;

/** Normalised rectangle, all values in 0..1 of the image's own dimensions. */
export interface NormalizedBox {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** One recognised region. */
export interface ImageRegion {
	/** Stable within one result, used as a list key and for link targets. */
	readonly id: string;
	/** Text as recognised in the image. */
	readonly source: string;
	/** Translated text. */
	readonly target: string;
	/**
	 * Where the region sits, when the model supplied a usable position.
	 *
	 * Absent means "recognised, but not locatable" — the region still appears in
	 * the list; it is simply not drawn on the image.
	 */
	readonly box?: NormalizedBox;
	/** The model flagged this region as uncertain. */
	readonly uncertain: boolean;
}

/** Bytes plus what they are. */
export interface ImageBytes {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
}

/** An image that passed validation and preprocessing. */
export interface ProcessedImage extends ImageBytes {
	/** Pixel dimensions of `bytes`. */
	readonly width: number;
	readonly height: number;
	/** Dimensions of the file the user supplied. */
	readonly originalWidth: number;
	readonly originalHeight: number;
	readonly originalBytes: number;
	/** Whether scaling or re-encoding changed the image. */
	readonly compressed: boolean;
}

/** Whether a region can be drawn. */
export function isLocatable(
	region: ImageRegion,
): region is ImageRegion & { box: NormalizedBox } {
	return region.box !== undefined;
}

/** Pixel dimensions of an image. */
export interface Dimensions {
	readonly width: number;
	readonly height: number;
}
