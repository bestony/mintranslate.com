/**
 * Analytics identifier resolution.
 *
 * Two levels of configuration decide whether anything is sent at all:
 *
 * 1. **Build time** — `VITE_GA_MEASUREMENT_ID` supplies the identifier, and
 *    `VITE_GA_ENABLED=false` is a hard off switch. These are the same variables
 *    `scripts/check-external-refs.mjs` reads, so the gate's view of "is analytics
 *    configured" and the runtime's view cannot disagree.
 * 2. **Runtime** — the user's own identifier from settings, used only when the
 *    build provided none. A build-provided identifier is authoritative, which is
 *    what lets a deployment pin analytics without users being able to override it.
 *
 * No new build-time variable is introduced: the contract in `runtime-config` names
 * these two, and adding a third would change what a deployment has to configure.
 */

import { logger } from "../logger";

/** Slot for the user-supplied identifier, following the project's naming. */
export const MEASUREMENT_ID_KEY = "mintranslate.analytics-id.v1";

/** Slot for the user-facing statistics toggle. */
export const ANALYTICS_ENABLED_KEY = "mintranslate.analytics-enabled.v1";

/** GA4 measurement identifiers look like `G-XXXXXXXXXX`. */
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,}$/i;

/** Whether a value looks like a GA4 measurement identifier. */
export function isValidMeasurementId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	// Whitespace inside an identifier is always a mistake (a copy-paste artifact),
	// so it is rejected rather than trimmed away silently.
	if (value !== value.trim()) return false;
	return MEASUREMENT_ID_PATTERN.test(value);
}

/** Minimal storage surface, satisfied by `localStorage` and by test doubles. */
export interface AnalyticsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
}

/** Resolve the browser's `localStorage`, or `undefined` when unavailable. */
function browserStorage(): AnalyticsStorage | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		// Storage can be blocked (private mode, enterprise policy).
		return undefined;
	}
}

/**
 * Build-time values, read from the bundler's inlined environment.
 *
 * A function rather than a captured constant so the values are read at call time,
 * and injectable so tests can exercise the precedence rules without manipulating
 * the environment.
 */
export interface BuildTimeSource {
	readonly measurementId?: string;
	readonly enabled?: string;
}

/** Default source: the bundler-inlined variables. */
function fromImportMeta(): BuildTimeSource {
	return {
		measurementId: import.meta.env?.VITE_GA_MEASUREMENT_ID,
		enabled: import.meta.env?.VITE_GA_ENABLED,
	};
}

/** Build-time identifier, if the variable holds a valid value. */
function buildTimeId(source: BuildTimeSource): string | undefined {
	return isValidMeasurementId(source.measurementId)
		? source.measurementId
		: undefined;
}

/**
 * Build-time master switch.
 *
 * Treated as "off" only for the literal `false`, matching the gate's reading, so
 * an unset or any other value leaves analytics governed by the identifier alone.
 */
function buildTimeEnabled(source: BuildTimeSource): boolean {
	return source.enabled?.trim().toLowerCase() !== "false";
}

/** User-supplied identifier, if stored and valid. */
export function storedId(
	storage: AnalyticsStorage | undefined = browserStorage(),
): string | undefined {
	if (!storage) return undefined;

	try {
		const raw = storage.getItem(MEASUREMENT_ID_KEY);
		return isValidMeasurementId(raw) ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** Persist a user-supplied identifier. Invalid values clear the slot. */
export function saveId(
	value: string,
	storage: AnalyticsStorage | undefined = browserStorage(),
): void {
	if (!storage) return;

	try {
		if (isValidMeasurementId(value)) storage.setItem(MEASUREMENT_ID_KEY, value);
		else storage.removeItem?.(MEASUREMENT_ID_KEY);
	} catch {
		// A preference is not worth surfacing an error for.
	}
}

/** Where the effective identifier came from. */
export type IdSource = "build" | "runtime" | "none";

/** The resolved analytics configuration. */
export interface AnalyticsConfig {
	/** `undefined` when analytics cannot run at all. */
	readonly measurementId: string | undefined;
	readonly source: IdSource;
	/** False when the build disabled analytics outright. */
	readonly buildEnabled: boolean;
	/** True when a deployment supplied the identifier (the settings field is read-only). */
	readonly fromDeployment: boolean;
}

/** Resolve the effective configuration. */
export function resolveConfig(
	storage: AnalyticsStorage | undefined = browserStorage(),
	build: BuildTimeSource = fromImportMeta(),
): AnalyticsConfig {
	const enabled = buildTimeEnabled(build);
	const fromBuild = buildTimeId(build);

	if (!enabled) {
		// The build switch wins over everything, including a stored identifier:
		// an intranet deployment must not be able to send data through a setting.
		return {
			measurementId: undefined,
			source: "none",
			buildEnabled: false,
			fromDeployment: false,
		};
	}

	if (fromBuild !== undefined) {
		return {
			measurementId: fromBuild,
			source: "build",
			buildEnabled: true,
			fromDeployment: true,
		};
	}

	const fromRuntime = storedId(storage);
	if (fromRuntime !== undefined) {
		return {
			measurementId: fromRuntime,
			source: "runtime",
			buildEnabled: true,
			fromDeployment: false,
		};
	}

	return {
		measurementId: undefined,
		source: "none",
		buildEnabled: true,
		fromDeployment: false,
	};
}

/**
 * Whether the user has left the statistics toggle on.
 *
 * Absent means on: the product decision is opt-out, not opt-in.
 */
export function statisticsEnabled(
	storage: AnalyticsStorage | undefined = browserStorage(),
): boolean {
	if (!storage) return true;

	try {
		return storage.getItem(ANALYTICS_ENABLED_KEY) !== "false";
	} catch {
		return true;
	}
}

/** Persist the toggle. */
export function saveStatisticsEnabled(
	enabled: boolean,
	storage: AnalyticsStorage | undefined = browserStorage(),
): void {
	if (!storage) return;

	try {
		storage.setItem(ANALYTICS_ENABLED_KEY, enabled ? "true" : "false");
	} catch {
		logger.debug("analytics.toggle.persist.failed");
	}
}
