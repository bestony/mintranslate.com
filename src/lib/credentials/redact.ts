/**
 * Secret redaction, used by connection diagnostics and (later) analytics.
 *
 * This is the single place that knows how to hide a secret. Every other module
 * must call into it rather than implementing its own masking, so there is one
 * function to audit and no path that can forget to redact.
 *
 * The rule is stricter than "mask the key": a secret must not be recoverable
 * from its masked form, and none of its substrings may survive. Only the last
 * four characters are kept, because users need to tell two keys apart.
 */

/** Shown in place of a secret that is too short to partially reveal. */
const FULLY_HIDDEN = "••••";

/** How many trailing characters a masked secret may keep. */
const VISIBLE_SUFFIX_LENGTH = 4;

/**
 * Mask a single secret for display.
 *
 * Short secrets reveal nothing at all: at four characters or fewer, showing the
 * tail would show the whole secret.
 */
export function maskSecret(secret: string): string {
	if (secret.length === 0) return "";
	if (secret.length <= VISIBLE_SUFFIX_LENGTH) return FULLY_HIDDEN;

	return `••••${secret.slice(-VISIBLE_SUFFIX_LENGTH)}`;
}

/**
 * Replace every occurrence of `secrets` in `input` with a fixed marker.
 *
 * Longest-first so a secret that contains another secret is replaced whole
 * rather than being partially matched by the shorter one first.
 *
 * Empty and very short strings are skipped: replacing every occurrence of a
 * one-character secret would shred the surrounding text, and such a value is
 * not a plausible API key.
 */
export function scrubSecrets(
	input: string,
	secrets: readonly string[],
): string {
	const usable = secrets
		.filter(
			(secret) =>
				typeof secret === "string" && secret.length > VISIBLE_SUFFIX_LENGTH,
		)
		.sort((a, b) => b.length - a.length);

	let output = input;
	for (const secret of usable) {
		output = output.split(secret).join("[redacted]");
	}

	return output;
}

/**
 * Whether `text` may have been produced without redaction.
 *
 * Used as a guard in tests and in the connection-test result path: given a set
 * of known secrets, it reports whether any of them survives verbatim.
 */
export function containsSecret(
	text: string,
	secrets: readonly string[],
): boolean {
	return secrets.some((secret) => secret.length > 0 && text.includes(secret));
}
