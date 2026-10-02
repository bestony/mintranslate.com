/**
 * Browser-side image preprocessing.
 *
 * One operation produces four required outcomes:
 *
 * - **orientation corrected** — the decoder is asked to apply the file's
 *   orientation, so the pixels are already upright;
 * - **scaled** — the longest edge is brought under the model's limit;
 * - **compressed** — encoded at a quality that fits the model's byte limit;
 * - **metadata removed** — the output comes from a fresh canvas, so nothing but
 *   pixels carries over. GPS coordinates, device model, timestamps and the
 *   orientation tag cannot survive, because they are never copied.
 *
 * The last point is why there is no EXIF parser here: deleting metadata segments
 * would need per-format code (JPEG segments, PNG chunks, WebP RIFF chunks) and
 * would still leave scaling and compression to do separately. Re-encoding does all
 * four in one pass and is harder to get wrong.
 *
 * The canvas work is reached through an injectable `ImageEnvironment` so the
 * pipeline can be tested without a canvas implementation, and so the same
 * function backs both the Worker and the main-thread fallback.
 */

import { logger } from "../logger";
import {
	type Dimensions,
	type ImageBytes,
	MAX_SENT_BYTES,
	MAX_SENT_EDGE_PX,
	type ProcessedImage,
} from "./model";
import { encodeAttempts, hasMoreAttempts } from "./resize";

/** A decoded image, held only for the duration of processing. */
export interface DecodedImage {
	readonly width: number;
	readonly height: number;
	/** Opaque handle passed back to the environment. */
	readonly handle: unknown;
}

/** The canvas and decoder operations preprocessing needs. */
export interface ImageEnvironment {
	/**
	 * Decode bytes, applying the file's orientation.
	 *
	 * Implementations must honour this: the returned dimensions are the
	 * post-rotation ones, which is what the rest of the pipeline assumes.
	 */
	decode(bytes: Uint8Array, mimeType: string): Promise<DecodedImage>;
	/** Draw at `target` size and encode; returns the encoded bytes. */
	encode(
		image: DecodedImage,
		target: Dimensions,
		quality: number,
		mimeType: string,
	): Promise<Uint8Array>;
	/** Release decoder-held memory. */
	release(image: DecodedImage): void;
}

/** Output format. JPEG keeps the smallest payload for photographic content. */
const OUTPUT_MIME_TYPE = "image/jpeg";

/**
 * Preprocess an image for sending to a model.
 *
 * `environment` is supplied by the caller so the Worker and the main-thread
 * fallback share this exact function — the requirement that both paths produce
 * the same result is only credible if there is one implementation.
 */
export async function preprocessImage(
	input: ImageBytes,
	environment: ImageEnvironment,
): Promise<ProcessedImage> {
	const originalBytes = input.bytes.byteLength;
	let decoded: DecodedImage | undefined;

	try {
		decoded = await environment.decode(input.bytes, input.mimeType);

		const originalDimensions: Dimensions = {
			width: decoded.width,
			height: decoded.height,
		};
		const attempts = encodeAttempts(originalDimensions);

		// Recorded before encoding so a slow or failed encode still says what was
		// attempted and why.
		logger.debug("image.preprocess.plan", {
			originalWidth: originalDimensions.width,
			originalHeight: originalDimensions.height,
			originalBytes,
			attempts: attempts.length,
			resized: attempts[0].needsResize,
		});

		let encoded: Uint8Array | undefined;
		let usedPlan = attempts[0];

		for (let index = 0; hasMoreAttempts(attempts, index); index += 1) {
			const plan = attempts[index];
			const candidate = await environment.encode(
				decoded,
				plan.target,
				plan.quality,
				OUTPUT_MIME_TYPE,
			);
			usedPlan = plan;

			if (candidate.byteLength <= MAX_SENT_BYTES) {
				encoded = candidate;
				break;
			}

			// Too big at this quality; try the next step. The last attempt is kept
			// even if it is still over the limit, because a slightly large image is
			// more useful than none, and the log records that it happened.
			encoded = candidate;
		}

		if (encoded === undefined) {
			// encodeAttempts always returns at least one entry; reaching here means
			// the environment produced nothing, which is a real failure.
			throw new Error("图像编码未产生输出");
		}

		const resized =
			usedPlan.target.width !== originalDimensions.width ||
			usedPlan.target.height !== originalDimensions.height;

		logger.debug("image.preprocess.done", {
			width: usedPlan.target.width,
			height: usedPlan.target.height,
			bytes: encoded.byteLength,
			quality: usedPlan.quality,
			resized,
			withinByteLimit: encoded.byteLength <= MAX_SENT_BYTES,
		});

		return {
			bytes: encoded,
			mimeType: OUTPUT_MIME_TYPE,
			width: usedPlan.target.width,
			height: usedPlan.target.height,
			originalWidth: originalDimensions.width,
			originalHeight: originalDimensions.height,
			originalBytes,
			compressed: resized || encoded.byteLength !== originalBytes,
		};
	} finally {
		// Released whether processing succeeded or threw: a leaked decoded bitmap
		// holds the full uncompressed image in memory.
		if (decoded !== undefined) environment.release(decoded);
	}
}

/** Limits the pipeline enforces, for messages. */
export const PREPROCESS_LIMITS = {
	maxEdgePx: MAX_SENT_EDGE_PX,
	maxBytes: MAX_SENT_BYTES,
	outputMimeType: OUTPUT_MIME_TYPE,
} as const;
