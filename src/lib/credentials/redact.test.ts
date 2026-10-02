import { describe, expect, it } from "vitest";

import { containsSecret, maskSecret, scrubSecrets } from "./redact";

/**
 * Synthetic fixtures shaped like a credential but deliberately not one.
 * Neutral words are used so the values are obviously invented.
 */
const KEY_A = "alpha-token-1111";
const KEY_B = "bravo-token-2222";
/** A proper suffix of KEY_A: length-ordered replacement must consume it whole. */
const KEY_A_TAIL = "token-1111";
/** Standalone long/short pair sharing a suffix. */
const KEY_LONG = "charlie-token-3333";
const KEY_LONG_TAIL = "token-3333";
/** A prefix of KEY_A that must never survive into a masked form. */
const KEY_A_PREFIX = "alpha";

describe("maskSecret", () => {
	it("returns empty for an empty secret", () => {
		expect(maskSecret("")).toBe("");
	});

	it("hides a short secret entirely", () => {
		// Revealing the tail of a 4-character secret would reveal all of it.
		expect(maskSecret("abcd")).toBe("••••");
		expect(maskSecret("abc")).toBe("••••");
	});

	it("keeps only the last four characters", () => {
		expect(maskSecret(KEY_A)).toBe("••••1111");
		expect(maskSecret(KEY_B)).toBe("••••2222");
	});

	it("does not reveal the secret prefix", () => {
		expect(maskSecret(KEY_A)).not.toContain(KEY_A_PREFIX);
	});
});

describe("scrubSecrets", () => {
	it("replaces every occurrence of a secret", () => {
		expect(scrubSecrets(`a ${KEY_A} b ${KEY_A}`, [KEY_A])).toBe(
			"a [redacted] b [redacted]",
		);
	});

	it("replaces the longest match first so no fragment survives", () => {
		expect(scrubSecrets(`key=${KEY_LONG}`, [KEY_LONG_TAIL, KEY_LONG])).toBe(
			"key=[redacted]",
		);
	});

	it("handles a secret that contains another secret", () => {
		// A shortest-first implementation would leave `[redacted]-1111` and leak
		// part of the value, so the exact output is the discriminating assertion.
		expect(scrubSecrets(`key=${KEY_A}`, [KEY_A_TAIL, KEY_A])).toBe(
			"key=[redacted]",
		);
	});

	it("ignores empty and short values so text is not shredded", () => {
		expect(scrubSecrets("hello world", ["", "o"])).toBe("hello world");
	});

	it("is a no-op when there are no secrets", () => {
		expect(scrubSecrets("unchanged", [])).toBe("unchanged");
	});

	it("scrubs secrets embedded in a JSON error body", () => {
		const body = JSON.stringify({ error: { message: `bad key: ${KEY_A}` } });
		const output = scrubSecrets(body, [KEY_A]);
		expect(output).not.toContain(KEY_A);
		expect(output).toContain("[redacted]");
	});

	it("leaves the status code and reason readable", () => {
		// The result view must show a status code and a body fragment, so
		// redaction must not blank the whole payload.
		expect(scrubSecrets(`401 ${KEY_A} invalid_api_key`, [KEY_A])).toBe(
			"401 [redacted] invalid_api_key",
		);
	});
});

describe("containsSecret", () => {
	it("detects a surviving secret", () => {
		expect(containsSecret(`x ${KEY_A} y`, [KEY_A])).toBe(true);
	});

	it("reports false once redacted", () => {
		const text = `fail: ${KEY_A}`;
		expect(containsSecret(scrubSecrets(text, [KEY_A]), [KEY_A])).toBe(false);
	});

	it("ignores empty search values", () => {
		expect(containsSecret("anything", [""])).toBe(false);
	});
});
