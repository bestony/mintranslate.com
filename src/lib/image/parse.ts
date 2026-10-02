/**
 * Structured result parsing.
 *
 * The model is asked for a JSON array, and models are inconsistent about
 * delivering exactly that: some wrap it in a code fence, some add a sentence of
 * preamble, some return a single object instead of an array. So the parser is
 * tolerant about **packaging** and strict about **content**.
 *
 * What it must never do is invent a result. A response it cannot read is reported
 * as a failure, which the caller turns into a retry and then an explicit
 * "could not parse" notice — never into an empty but confident-looking result.
 *
 * Coordinate handling is deliberately lenient in one direction only: out-of-range
 * values drop the box but keep the region. Losing the position costs the overlay;
 * losing the region would lose text the model actually read.
 */

import { logger } from "../logger";
import type { ImageRegion, NormalizedBox } from "./model";

/** Parsed result, or a reason it could not be read. */
export type ParseResult =
	| { readonly ok: true; readonly regions: readonly ImageRegion[] }
	| { readonly ok: false; readonly reason: string };

/**
 * Extract the first JSON array or object from a text response.
 *
 * Scans for a bracket rather than trying `JSON.parse` on the whole string, because
 * a code fence or a leading sentence would make that fail even though the payload
 * is intact.
 */
function extractJson(text: string): string | undefined {
	const trimmed = text.trim();

	// Fast path: the whole response is the payload.
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		const end = trimmed.lastIndexOf(trimmed.startsWith("[") ? "]" : "}");
		if (end > 0) {
			return trimmed.slice(0, end + 1);
		}
	}

	// Otherwise take the outermost array, then the outermost object.
	for (const [open, close] of [
		["[", "]"],
		["{", "}"],
	] as const) {
		const start = trimmed.indexOf(open);
		const end = trimmed.lastIndexOf(close);
		if (start !== -1 && end > start) {
			return trimmed.slice(start, end + 1);
		}
	}

	return undefined;
}

/** Whether a value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read a box, or nothing.
 *
 * Returns `undefined` for a missing box and for one outside 0..1 — both mean "not
 * locatable", and the caller treats them the same way.
 */
function readBox(raw: unknown): NormalizedBox | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const candidate = raw as Record<string, unknown>;

	const { x, y, width, height } = candidate;
	if (
		!isFiniteNumber(x) ||
		!isFiniteNumber(y) ||
		!isFiniteNumber(width) ||
		!isFiniteNumber(height)
	) {
		return undefined;
	}

	if (width <= 0 || height <= 0) return undefined;

	// A model that returns percentages (0..100) is a common failure; treating those
	// as invalid keeps the overlay honest instead of drawing a box far off-canvas.
	const inRange = (value: number) => value >= 0 && value <= 1;
	if (!inRange(x) || !inRange(y) || !inRange(width) || !inRange(height)) {
		return undefined;
	}

	// A box that would extend past the edge is clipped rather than dropped: the
	// model meant to cover the region, and the visible part is still useful.
	// Clipping is applied only when it is needed, so a box that already fits keeps
	// the model's exact values instead of picking up floating-point noise.
	const overflowsRight = x + width > 1;
	const overflowsBottom = y + height > 1;
	return {
		x,
		y,
		width: overflowsRight ? 1 - x : width,
		height: overflowsBottom ? 1 - y : height,
	};
}

/** Read one region, or nothing when it carries no usable text. */
function readRegion(raw: unknown, index: number): ImageRegion | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const candidate = raw as Record<string, unknown>;

	const source =
		typeof candidate.source === "string" ? candidate.source.trim() : "";
	const target =
		typeof candidate.target === "string" ? candidate.target.trim() : "";

	// A region with no text at all is noise; keeping it would render an empty row.
	if (source === "" && target === "") return undefined;

	const box = readBox(candidate.box);

	return {
		id:
			typeof candidate.id === "string" && candidate.id !== ""
				? candidate.id
				: `r${index}`,
		source,
		target,
		...(box !== undefined && { box }),
		uncertain: candidate.uncertain === true,
	};
}

/** Parse a model response into regions. */
export function parseRegions(text: string): ParseResult {
	const json = extractJson(text);
	if (json === undefined) {
		logger.debug("image.parse.no-json", { length: text.length });
		return { ok: false, reason: "响应中没有可识别的 JSON 结构" };
	}

	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		logger.debug("image.parse.invalid-json", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return { ok: false, reason: "响应中的 JSON 无法解析" };
	}

	// A single object is accepted as a one-region result: the shape is what matters,
	// not the packaging.
	const list = Array.isArray(value) ? value : [value];

	const regions = list
		.map((entry, index) => readRegion(entry, index))
		.filter((region): region is ImageRegion => region !== undefined);

	if (regions.length === 0) {
		// Distinguish "no text found" from "could not read": an empty array from the
		// model is a valid answer meaning no text, so it is reported as a success
		// with zero regions. Only a list with no usable entries is a failure.
		if (Array.isArray(value) && value.length === 0) {
			logger.debug("image.parse.empty", {});
			return { ok: true, regions: [] };
		}
		return { ok: false, reason: "响应中没有可用的文本区域" };
	}

	logger.debug("image.parse.done", {
		regions: regions.length,
		locatable: regions.filter((region) => region.box !== undefined).length,
		uncertain: regions.filter((region) => region.uncertain).length,
	});

	return { ok: true, regions };
}

/** Whether a parsed result is an empty but valid answer. */
export function isEmptyResult(result: ParseResult): boolean {
	return result.ok && result.regions.length === 0;
}
