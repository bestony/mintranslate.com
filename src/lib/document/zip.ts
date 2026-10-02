/**
 * Zip access for OOXML packages.
 *
 * A thin wrapper over `fflate`, kept separate so the package-level logic above it
 * never touches the zip library's API directly. Only three operations are needed:
 * list entries, read one, and write a package back with some entries replaced.
 *
 * `fflate` was chosen over a fuller zip library because those three operations are
 * the whole requirement. The alternative considered — the platform's
 * `DecompressionStream("deflate-raw")` — can decompress but **not compress**, and
 * rebuilding a translated package requires compression, so a library is unavoidable
 * either way. See design D1.
 */

import { unzipSync, zipSync } from "fflate";

/** An OOXML package: its entries, keyed by path inside the zip. */
export type PackageEntries = Record<string, Uint8Array>;

/** Read every entry of a package. */
export function readPackage(bytes: Uint8Array): PackageEntries {
	return unzipSync(bytes);
}

/**
 * Write a package back.
 *
 * Entries are re-deflated. `level: 6` matches what the office suites use and keeps
 * rebuilds close to the original size; the level is not exposed because nothing in
 * the requirements asks for it.
 */
export function writePackage(entries: PackageEntries): Uint8Array {
	return zipSync(entries, { level: 6 });
}

/** Decode an entry as UTF-8 text, or `undefined` when the entry is absent. */
export function readTextEntry(
	entries: PackageEntries,
	path: string,
): string | undefined {
	const bytes = entries[path];
	if (bytes === undefined) return undefined;
	return new TextDecoder("utf-8").decode(bytes);
}

/** Encode text into an entry, replacing any existing content. */
export function writeTextEntry(
	entries: PackageEntries,
	path: string,
	text: string,
): void {
	entries[path] = new TextEncoder().encode(text);
}

/**
 * Paths of entries matching a pattern.
 *
 * Used for the families that come numbered: `header1.xml`, `header2.xml`,
 * `footer1.xml` and so on. Enumerating them by pattern is what keeps a document's
 * second header from being silently skipped.
 */
export function entryPathsMatching(
	entries: PackageEntries,
	pattern: RegExp,
): string[] {
	return Object.keys(entries)
		.filter((path) => pattern.test(path))
		.sort();
}
