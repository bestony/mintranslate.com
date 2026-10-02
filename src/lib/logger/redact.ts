/**
 * Log payload redaction.
 *
 * The rule this module enforces: by default a log record must not contain a
 * secret, an `Authorization` value, or the full source text.
 *
 * Two mechanisms, deliberately distinct:
 *
 * - **Automatic**: any object key that looks like a credential is replaced, and
 *   any string value is swept for known secrets by the shared redactor.
 * - **Declared**: a caller marks a field as source text with `textField()`. That
 *   keeps the value behind a marker so the effective log level decides whether
 *   it is emitted, instead of the caller having to check the level itself.
 *
 * Redaction itself is not reimplemented here: secrets go through
 * `scrubSecrets` from the credentials module, which is the single masking
 * implementation in the codebase.
 */

import { scrubSecrets } from "../credentials/redact";

/** Visible in place of source text when the level is not verbose enough. */
const TEXT_WITHHELD = "[原文已省略]";

/**
 * A declared source-text field.
 *
 * Wrapping the value keeps "this is user content" visible at the call site.
 * `log()` decides whether to include it.
 */
export interface TextField {
	readonly __text: true;
	readonly value: string;
}

/** Mark a string as source text so its emission follows the log level. */
export function textField(value: string): TextField {
	return { __text: true, value };
}

/** Whether a key names something that must never be logged verbatim. */
function isSensitiveKey(key: string): boolean {
	const lowered = key.toLowerCase();

	return (
		lowered === "authorization" ||
		lowered === "cookie" ||
		lowered === "set-cookie" ||
		lowered === "apikey" ||
		lowered === "api_key" ||
		lowered === "key" ||
		lowered === "password" ||
		lowered === "secret" ||
		lowered === "token" ||
		lowered.endsWith("apikey") ||
		lowered.endsWith("_key") ||
		lowered.endsWith("token") ||
		lowered.endsWith("secret")
	);
}

/** Whether a level may emit source text. */
function allowsSourceText(level: string): boolean {
	// Only the verbosity meant for investigation exposes user content.
	return level === "debug";
}

/**
 * Redact one value for logging.
 *
 * `level` decides whether a declared text field is emitted; secrets are stripped
 * at every level, including `debug`.
 */
export function redactValue(
	value: unknown,
	options: {
		readonly level: string;
		readonly secrets: readonly string[];
		readonly depth?: number;
	},
): unknown {
	const depth = options.depth ?? 0;

	// Depth guard: a cyclic or very deep object must not hang the logger.
	if (depth > 4) return "[深度截断]";

	if (value === null || value === undefined) return value;

	if (typeof value === "string") {
		return scrubSecrets(value, options.secrets);
	}

	if (typeof value === "number" || typeof value === "boolean") return value;

	if (typeof value === "bigint") return value.toString();

	if (typeof value === "function") return "[函数]";

	if (Array.isArray(value)) {
		return value.map((entry) =>
			redactValue(entry, { ...options, depth: depth + 1 }),
		);
	}

	if (value instanceof Error) {
		return {
			name: value.name,
			// An error message can embed a secret or a URL with a key in it.
			message: scrubSecrets(value.message, options.secrets),
		};
	}

	if (typeof value === "object") {
		// A declared source-text field: keep metadata always, content only when
		// the level allows it. Even then the content is swept for known secrets:
		// secrets are stripped at every level, including the verbose one.
		const candidate = value as Partial<TextField>;
		if (candidate.__text === true && typeof candidate.value === "string") {
			return allowsSourceText(options.level)
				? scrubSecrets(candidate.value, options.secrets)
				: `${TEXT_WITHHELD}（长度 ${candidate.value.length}）`;
		}

		const output: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (isSensitiveKey(key)) {
				output[key] = "[已脱敏]";
				continue;
			}
			output[key] = redactValue(entry, { ...options, depth: depth + 1 });
		}
		return output;
	}

	return String(value);
}

/** Whether the given level emits declared source text. */
export { allowsSourceText };
