/**
 * Structured logger.
 *
 * Design constraints this module exists to satisfy (spec `translation-logging`):
 *
 * - **Filter before constructing.** A call below the threshold returns before the
 *   message is built, so a verbose-but-disabled record costs nothing and cannot
 *   leak content into a discarded string.
 * - **Redact by default.** Secrets and `Authorization` values never reach the
 *   sink; source text only at the verbosity meant for investigation.
 * - **Never break the caller.** A failing sink must not surface as an exception
 *   in business code, and logging must not reorder or delay a request.
 *
 * Records carry a `requestId` when the caller has one, so a single translation's
 * lines can be reassembled.
 */

import { scrubSecrets } from "../credentials/redact";
import { type LogLevel, passesThreshold } from "./levels";
import { redactValue, type TextField, textField } from "./redact";
import { resolveLogLevel } from "./threshold";

export { LOG_LEVELS, type LogLevel } from "./levels";
export { type TextField, textField } from "./redact";
export { LOG_LEVEL_STORAGE_KEY } from "./threshold";

/** Structured fields attached to a record. */
export type LogFields = Record<string, unknown>;

/** A single emitted record. */
export interface LogRecord {
	readonly level: LogLevel;
	/** Short machine-readable event name, e.g. `translation.request.start`. */
	readonly event: string;
	readonly timestamp: number;
	/** Correlates the records belonging to one translation. */
	readonly requestId?: string;
	readonly fields: LogFields;
}

/** Destination for accepted records. Injectable so tests can capture them. */
export interface LogSink {
	write(record: LogRecord): void;
}

/** Console sink. Writes nothing when there is no console (prerender). */
const consoleSink: LogSink = {
	write(record) {
		if (typeof console === "undefined") return;

		const prefix = record.requestId
			? `[${record.event}][${record.requestId}]`
			: `[${record.event}]`;
		const payload = { ...record.fields };

		if (record.level === "error") console.error(prefix, payload);
		else if (record.level === "warn") console.warn(prefix, payload);
		else if (record.level === "info") console.info(prefix, payload);
		else console.debug(prefix, payload);
	},
};

/** Options accepted by every level method. */
export interface LogOptions {
	readonly requestId?: string;
	readonly secrets?: readonly string[];
}

/** The logger surface. */
export interface Logger {
	debug(event: string, fields?: LogFields, options?: LogOptions): void;
	info(event: string, fields?: LogFields, options?: LogOptions): void;
	warn(event: string, fields?: LogFields, options?: LogOptions): void;
	error(event: string, fields?: LogFields, options?: LogOptions): void;
	/** Whether a level would currently be emitted. */
	enabled(level: LogLevel): boolean;
}

/** Injectable seams, used by tests and by the app to install a sink. */
export interface LoggerDeps {
	readonly sink?: LogSink;
	/** Overrides threshold resolution, e.g. for a fixed level in tests. */
	readonly level?: () => LogLevel;
}

/** Create a logger. */
export function createLogger(deps: LoggerDeps = {}): Logger {
	const sink = deps.sink ?? consoleSink;
	const levelOf = deps.level ?? (() => resolveLogLevel());

	function emit(
		level: LogLevel,
		event: string,
		fields: LogFields | undefined,
		options: LogOptions | undefined,
	): void {
		// Resolve the threshold first: everything below this line is work that a
		// disabled record should not pay for.
		let threshold: LogLevel;
		try {
			threshold = levelOf();
		} catch {
			return;
		}

		if (!passesThreshold(level, threshold)) return;

		try {
			const secrets = options?.secrets ?? [];
			const redactedFields = redactValue(fields ?? {}, {
				level,
				secrets,
			}) as LogFields;

			const record: LogRecord = {
				level,
				event,
				timestamp: Date.now(),
				...(options?.requestId !== undefined && {
					requestId: options.requestId,
				}),
				fields: redactedFields,
			};

			sink.write(record);
		} catch {
			// A logger that throws becomes the outage. Swallow: the caller's work
			// matters more than this record.
		}
	}

	return {
		debug: (event, fields, options) => emit("debug", event, fields, options),
		info: (event, fields, options) => emit("info", event, fields, options),
		warn: (event, fields, options) => emit("warn", event, fields, options),
		error: (event, fields, options) => emit("error", event, fields, options),
		enabled: (level) => {
			try {
				return passesThreshold(level, levelOf());
			} catch {
				return false;
			}
		},
	};
}

/**
 * Application logger.
 *
 * A module-level instance so every call site shares one threshold and one sink,
 * and so raising verbosity applies everywhere at once.
 */
export const logger = createLogger();

/**
 * Generate a short readable correlation id.
 *
 * Eight characters of a UUID: long enough that collisions within one session are
 * not a practical concern, short enough to read in a log line.
 */
export function newRequestId(): string {
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.randomUUID === "function"
	) {
		return crypto.randomUUID().slice(0, 8);
	}
	// Fallback for environments without `randomUUID` (older Safari).
	return Math.random().toString(36).slice(2, 10);
}

/** Convenience: a redacted view of a string using the shared redactor. */
export function redactForLog(
	value: string,
	secrets: readonly string[] = [],
): string {
	return scrubSecrets(value, secrets);
}

/** Re-exported so callers do not need to import the redaction module directly. */
export { textField as logTextField };

/** Convenience for building a source-text field without importing the helper. */
export function sourceText(value: string): TextField {
	return textField(value);
}
