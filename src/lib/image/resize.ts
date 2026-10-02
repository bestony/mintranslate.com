/**
 * Resize and quality planning.
 *
 * Separated from the drawing code because it is the part with arithmetic worth
 * testing, and because the decision "do not shrink what already fits" is easy to
 * lose when it is entangled with canvas calls.
 */

import { type Dimensions, MAX_SENT_EDGE_PX } from "./model";

/** What the encoder should produce. */
export interface EncodePlan {
	readonly target: Dimensions;
	/** Quality for a lossy encoder, 0..1. */
	readonly quality: number;
	/** Whether anything changed, i.e. whether a re-encode is needed. */
	readonly needsResize: boolean;
}

/**
 * Scale a dimension pair down so its longest edge is at most `maxEdge`.
 *
 * Never scales up: a small image has no detail to gain, and enlarging it would
 * inflate the payload and the model's input cost for nothing.
 */
export function scaleToFit(
	dimensions: Dimensions,
	maxEdge: number = MAX_SENT_EDGE_PX,
): Dimensions {
	const longest = Math.max(dimensions.width, dimensions.height);
	if (longest <= maxEdge || longest === 0) return dimensions;

	const ratio = maxEdge / longest;
	return {
		// At least one pixel on each side: rounding must not produce a zero-sized
		// canvas, which would fail to encode.
		width: Math.max(1, Math.round(dimensions.width * ratio)),
		height: Math.max(1, Math.round(dimensions.height * ratio)),
	};
}

/** Starting quality before size-driven reduction. */
const INITIAL_QUALITY = 0.85;

/**
 * Quality steps tried when the encoded result is still too large.
 *
 * A short descending list rather than a search: each step costs a full encode, and
 * below the last step the image would be visibly degraded anyway — at that point
 * scaling further is the better lever.
 */
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55] as const;

/**
 * The sequence of encode attempts for an image.
 *
 * Returns candidates in order, each with the dimensions and quality to try. The
 * caller stops at the first attempt whose output fits the byte limit, so the
 * common case (already small enough) makes exactly one attempt.
 */
export function encodeAttempts(original: Dimensions): readonly EncodePlan[] {
	const first = scaleToFit(original);

	// Already inside both limits: keep the original dimensions and encode once at
	// high quality rather than shrinking something that was fine.
	if (first.width === original.width && first.height === original.height) {
		return [{ target: first, quality: INITIAL_QUALITY, needsResize: false }];
	}

	return QUALITY_STEPS.map((quality) => ({
		target: first,
		quality,
		needsResize: true,
	}));
}

/**
 * Whether a further attempt is worth making.
 *
 * Kept explicit so the caller's loop condition is not a bare index comparison,
 * and so the "all attempts exhausted" case has a name.
 */
export function hasMoreAttempts(
	attempts: readonly EncodePlan[],
	attemptIndex: number,
): boolean {
	return attemptIndex < attempts.length;
}
