/** Character n-gram extraction and similarity scoring. */

import { normalizeSearchText } from "./model";

/** Broad CJK ranges cover Han, kana, hangul and common compatibility blocks. */
export function isCjkCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x3040 && codePoint <= 0x30ff) ||
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7af) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0x20000 && codePoint <= 0x2ffff)
	);
}

/** Return the index width required by the text's writing system. */
export function ngramSize(text: string): 2 | 3 {
	for (const character of text) {
		if (isCjkCodePoint(character.codePointAt(0) ?? 0)) return 2;
	}
	return 3;
}

/** Extract unique, normalized character n-grams. */
export function getNgrams(text: string): readonly string[] {
	const normalized = normalizeSearchText(text);
	if (normalized === "") return [];

	const codePoints = Array.from(normalized);
	const width = ngramSize(normalized);
	if (codePoints.length < width) return [normalized];

	const grams = new Set<string>();
	for (let index = 0; index <= codePoints.length - width; index += 1) {
		grams.add(codePoints.slice(index, index + width).join(""));
	}
	return [...grams];
}

/** Dice coefficient over unique n-gram sets. */
export function diceCoefficient(
	left: readonly string[] | ReadonlySet<string>,
	right: readonly string[] | ReadonlySet<string>,
): number {
	const leftSet = left instanceof Set ? left : new Set(left);
	const rightSet = right instanceof Set ? right : new Set(right);
	if (leftSet.size === 0 && rightSet.size === 0) return 1;
	if (leftSet.size === 0 || rightSet.size === 0) return 0;

	let intersection = 0;
	for (const gram of leftSet) if (rightSet.has(gram)) intersection += 1;
	return (2 * intersection) / (leftSet.size + rightSet.size);
}

/** Jaccard coefficient, exported for callers that prefer that interpretation. */
export function jaccardCoefficient(
	left: readonly string[] | ReadonlySet<string>,
	right: readonly string[] | ReadonlySet<string>,
): number {
	const leftSet = left instanceof Set ? left : new Set(left);
	const rightSet = right instanceof Set ? right : new Set(right);
	if (leftSet.size === 0 && rightSet.size === 0) return 1;

	let intersection = 0;
	for (const gram of leftSet) if (rightSet.has(gram)) intersection += 1;
	const union = leftSet.size + rightSet.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Whether the normalized query is contained in either indexed text field. */
export function containsNormalizedText(
	query: string,
	sourceText: string,
	targetText: string,
): boolean {
	const needle = normalizeSearchText(query);
	if (needle === "") return true;
	return (
		normalizeSearchText(sourceText).includes(needle) ||
		normalizeSearchText(targetText).includes(needle)
	);
}
