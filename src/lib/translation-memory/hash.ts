/** Exact-key helpers. */

import {
	type MemoryContext,
	normalizeMemoryContext,
	normalizeMemoryText,
} from "./model";

/** Length-prefix fields so delimiter characters in user text cannot be ambiguous. */
export function buildMemoryFingerprint(
	sourceText: string,
	context: Partial<MemoryContext>,
): string {
	const normalizedContext = normalizeMemoryContext(context);
	const fields = [
		normalizeMemoryText(sourceText),
		normalizedContext.sl,
		normalizedContext.tl,
		normalizedContext.glossaryVersion,
		normalizedContext.styleId,
		normalizedContext.tier,
	];

	return fields.map((field) => `${field.length}:${field}`).join("|");
}

/** Deterministic fallback for environments without Web Crypto. */
export function fallbackHash(value: string): string {
	// Two independent 32-bit accumulators make accidental collisions less likely
	// while keeping this path synchronous and available in old test environments.
	let left = 0x811c9dc5;
	let right = 0x01000193;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		left ^= codePoint;
		left = Math.imul(left, 0x01000193);
		right ^= codePoint + 0x9e3779b9;
		right = Math.imul(right, 0x85ebca6b);
	}
	return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
		.toString(16)
		.padStart(8, "0")}`;
}

/** Hash an exact-key fingerprint with SHA-256 when available. */
export async function hashMemoryFingerprint(value: string): Promise<string> {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi?.subtle !== undefined) {
		try {
			const bytes = new TextEncoder().encode(value);
			const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
			return Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
		} catch {
			// Fall through to the deterministic implementation below. A browser may
			// expose crypto while denying subtle operations in a restricted context.
		}
	}
	return fallbackHash(value);
}

/** Build and hash the exact lookup key. */
export async function hashMemoryKey(
	sourceText: string,
	context: Partial<MemoryContext>,
): Promise<{ readonly fingerprint: string; readonly sourceHash: string }> {
	const fingerprint = buildMemoryFingerprint(sourceText, context);
	return { fingerprint, sourceHash: await hashMemoryFingerprint(fingerprint) };
}

/** Synchronous key helper useful for deterministic tests and diagnostics. */
export function hashMemoryKeySync(
	sourceText: string,
	context: Partial<MemoryContext>,
): { readonly fingerprint: string; readonly sourceHash: string } {
	const fingerprint = buildMemoryFingerprint(sourceText, context);
	return { fingerprint, sourceHash: fallbackHash(fingerprint) };
}
