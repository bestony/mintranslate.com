/**
 * Log levels, ordered by severity.
 *
 * Only these four: more granularity would be invented rather than needed, and
 * anything less could not distinguish "something to look at" from "something
 * broke".
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric rank so filtering is a comparison rather than a lookup table. */
const LEVEL_RANK: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

/** Threshold used when neither runtime nor build-time configuration exists. */
export const DEFAULT_LOG_LEVEL: LogLevel = "warn";

/** Whether `value` is a valid level. */
export function isLogLevel(value: unknown): value is LogLevel {
	return (
		typeof value === "string" &&
		(LOG_LEVELS as readonly string[]).includes(value)
	);
}

/** Whether a record at `level` passes `threshold`. */
export function passesThreshold(level: LogLevel, threshold: LogLevel): boolean {
	return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}
