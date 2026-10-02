/**
 * Threshold resolution.
 *
 * Order, highest priority first:
 *
 * 1. runtime override in browser storage (so a user or a support engineer can
 *    raise verbosity without rebuilding);
 * 2. build-time variable (so a deployment can ship a different default);
 * 3. `warn`.
 *
 * No network involvement: a threshold that needed a request would be useless in
 * exactly the situation it is wanted (an offline or locked-down install).
 */

import { DEFAULT_LOG_LEVEL, isLogLevel, type LogLevel } from "./levels";

/** Storage slot for the runtime threshold override. */
export const LOG_LEVEL_STORAGE_KEY = "mintranslate.log-level.v1";

/** Minimal read surface, satisfied by `localStorage` and by test doubles. */
export interface LevelStorage {
	getItem(key: string): string | null;
}

/**
 * Build-time default.
 *
 * Read through `import.meta.env` so it is inlined at build time; an unset
 * variable yields `undefined` and falls through to the constant default.
 */
function buildTimeLevel(): LogLevel | undefined {
	const raw = import.meta.env?.VITE_LOG_LEVEL;
	return isLogLevel(raw) ? raw : undefined;
}

/** Runtime override, if present and valid. */
export function runtimeLevel(
	storage: LevelStorage | undefined = currentStorage(),
): LogLevel | undefined {
	if (!storage) return undefined;

	try {
		const raw = storage.getItem(LOG_LEVEL_STORAGE_KEY);
		return isLogLevel(raw) ? raw : undefined;
	} catch {
		// Storage can throw (private mode, blocked cookies). A threshold lookup
		// must never be the reason logging breaks.
		return undefined;
	}
}

/** Resolve the effective threshold. */
export function resolveLogLevel(
	storage: LevelStorage | undefined = currentStorage(),
	buildLevel: LogLevel | undefined = buildTimeLevel(),
): LogLevel {
	return runtimeLevel(storage) ?? buildLevel ?? DEFAULT_LOG_LEVEL;
}

/** `localStorage` when running in a browser, otherwise `undefined`. */
function currentStorage(): LevelStorage | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}
