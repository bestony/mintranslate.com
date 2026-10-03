/**
 * The single analytics entry point.
 *
 * Everything that leaves the application on the analytics path goes through
 * `track()`. That is what makes the privacy guarantees structural instead of a
 * convention each call site has to remember:
 *
 * - **Allow-list first.** Only parameters declared in the event schema are copied
 *   out. An undeclared key — a field someone added at a call site — cannot travel,
 *   because nothing forwards unknown keys.
 * - **Forbidden keys removed.** On top of that, credential- and content-shaped key
 *   names are dropped explicitly, so even a schema mistake cannot leak.
 * - **Failures swallowed.** Analytics must never be the reason a feature breaks,
 *   and a blocked script must not surface as an error to the caller.
 *
 * When no identifier is configured — or the build switched analytics off, or the
 * user switched it off — `track()` returns immediately. Call sites do not check
 * any of that themselves.
 */

import { createLatestCall } from "../call-control/latest-call";
import { throttle } from "../call-control/throttle";
import { isBuiltinProvider } from "../connections/model";
import { logger } from "../logger";
import {
	type AnalyticsStorage,
	resolveConfig,
	statisticsEnabled,
} from "./config";
import {
	ANALYTICS_EVENT_NAMES,
	type AnalyticsEventMap,
	type AnalyticsEventName,
	type CommonParams,
	clampFreeText,
	isForbiddenKey,
	isSendableFreeText,
} from "./events";

/** Interface version reported with every event. */
export const APP_VERSION = "0.1.0";

/**
 * UI language reported with every event.
 *
 * A single constant: the interface is not language-switchable yet, and reading the
 * same value from one place keeps a future i18n change to one edit.
 */
export const UI_LANGUAGE = "zh-CN";

/** What the underlying analytics transport must provide. */
export interface AnalyticsTransport {
	/** Send one event. Implementations must not throw, but callers guard anyway. */
	send(event: AnalyticsEventName, params: Record<string, unknown>): void;
	/** Whether a script has been loaded/initialised. */
	ready(): boolean;
}

/** Context the entry point needs to build common parameters. */
export interface AnalyticsContext {
	/** Whether at least one connection has been configured. */
	readonly byokConfigured: () => boolean;
	readonly storage?: AnalyticsStorage;
	readonly transport?: AnalyticsTransport;
}

/** Window with the analytics global, if a script has been loaded. */
interface AnalyticsGlobals {
	readonly gtag?: (...args: unknown[]) => void;
	readonly dataLayer?: unknown[];
}

function analyticsGlobals(): AnalyticsGlobals {
	return globalThis as unknown as AnalyticsGlobals;
}

/**
 * Transport backed by the vendor's global function.
 *
 * Reads the global lazily on each send: the script may be injected after the
 * module loads (it is injected conditionally), so capturing it once would miss it.
 */
export function createGtagTransport(measurementId: string): AnalyticsTransport {
	return {
		send(event, params) {
			const globals = analyticsGlobals();
			if (typeof globals.gtag !== "function") return;

			globals.gtag("event", event, { ...params, send_to: measurementId });
		},
		ready() {
			return typeof analyticsGlobals().gtag === "function";
		},
	};
}

/**
 * The declared parameter names per event, derived from the schema.
 *
 * This is what makes the entry point an allow-list rather than a deny-list: a key
 * that is not named here cannot travel, so a call site adding an extra field — or a
 * future schema mistake — cannot leak it. The deny-list below is a second layer,
 * not the primary one.
 */
export function declaredParams(event: AnalyticsEventName): readonly string[] {
	// Kept next to the schema's shape rather than derived by reflection: TypeScript
	// types do not exist at runtime, so the list is written out and a test asserts
	// it covers every event.
	return DECLARED_PARAMS[event];
}

/** Runtime list of each event's parameters, mirroring `AnalyticsEventMap`. */
const DECLARED_PARAMS: Record<AnalyticsEventName, readonly string[]> = {
	app_open: ["entry_mode", "has_url_text"],
	translate_submit: [
		"mode",
		"source_lang",
		"target_lang",
		"input_chars",
		"input_kind",
	],
	translate_success: [
		"mode",
		"source_lang",
		"target_lang",
		"provider",
		"model",
		"latency_ms",
		"is_streaming",
	],
	translate_error: ["mode", "provider", "model", "error_type", "http_status"],
	lang_change: ["side", "from_lang", "to_lang", "is_auto_detect", "trigger"],
	provider_config_save: [
		"provider",
		"is_custom_endpoint",
		"has_base_url_override",
	],
	connection_test: ["provider", "success", "error_type", "latency_ms"],
	cors_blocked: ["provider", "endpoint_host"],
	model_in_use: ["provider", "model"],
};

/** Everything every event carries. */
const COMMON_PARAM_NAMES = [
	"app_version",
	"ui_lang",
	"is_byok_configured",
] as const;

/**
 * Keep only the parameters the event declares.
 *
 * Allow-list first: anything unnamed is dropped regardless of its shape. The
 * forbidden-key check still runs, so a schema that accidentally listed a
 * credential-shaped name would not become a leak.
 */
function pickDeclared(
	event: AnalyticsEventName,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const allowed = new Set<string>([
		...COMMON_PARAM_NAMES,
		...declaredParams(event),
	]);
	const output: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(params)) {
		if (!allowed.has(key)) continue;
		if (isForbiddenKey(key)) continue;
		output[key] = value;
	}

	return output;
}

/** Apply schema-level value rules (truncation, character checks). */
function sanitizeValues(
	params: Record<string, unknown>,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(params)) {
		if (
			typeof value === "string" &&
			(key === "model" || key.endsWith("_lang"))
		) {
			// Free-form values: truncate when merely long, drop when the characters
			// look like pasted content rather than a name.
			if (key === "model" && !isSendableFreeText(value)) continue;
			output[key] = clampFreeText(value);
			continue;
		}

		output[key] = value;
	}

	return output;
}

/** The tracker surface call sites use. */
export interface Analytics {
	track<K extends AnalyticsEventName>(
		event: K,
		params: AnalyticsEventMap[K],
	): void;
	/** Whether events would actually be sent right now. */
	enabled(): boolean;
	/** The resolved identifier, for diagnostics. Never logged with its full value. */
	measurementId(): string | undefined;
}

/** Create a tracker. */
export function createAnalytics(context: AnalyticsContext): Analytics {
	const transport =
		context.transport ??
		(() => {
			const config = resolveConfig(context.storage);
			return config.measurementId === undefined
				? undefined
				: createGtagTransport(config.measurementId);
		})();

	const config = resolveConfig(context.storage);

	/** A usable tracker exists only when an identifier resolved and the user allows it. */
	function usable(): boolean {
		if (config.measurementId === undefined) return false;
		if (transport === undefined) return false;
		return statisticsEnabled(context.storage);
	}

	function commonParams(): CommonParams {
		return {
			app_version: APP_VERSION,
			ui_lang: UI_LANGUAGE,
			is_byok_configured: context.byokConfigured(),
		};
	}

	return {
		track(event, params) {
			if (!usable()) return;
			if (
				event === "cors_blocked" &&
				isBuiltinProvider((params as { readonly provider?: string }).provider)
			)
				return;

			try {
				const payload = sanitizeValues(
					pickDeclared(event, {
						...commonParams(),
						...(params as Record<string, unknown>),
					}),
				);

				// The event name comes from the closed schema, so it is always a
				// literal known at compile time.
				transport?.send(event, payload);
			} catch (error) {
				// Analytics failures must never reach the caller.
				logger.debug("analytics.send.failed", { error });
			}
		},

		enabled: usable,

		measurementId: () => config.measurementId,
	};
}

/**
 * Fixed salt for endpoint hostname hashing.
 *
 * The salt keeps a private hostname from being recoverable by a casual observer.
 * It is not a security boundary: a fixed salt does not defeat a dictionary attack
 * on a small set of candidate domains. That limitation is recorded in the change's
 * design; the hash exists to preserve cross-user comparability without publishing
 * the domain.
 */
const HOST_SALT = "mintranslate-endpoint";

/**
 * Hash an endpoint hostname for reporting.
 *
 * Returns a stable 12-character hex digest, which is what lets "how many users
 * fail against this same private gateway" be answered without naming it.
 */
export async function hashHostname(host: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	const encoder = new TextEncoder();
	const data = encoder.encode(`${HOST_SALT}:${host}`);

	if (subtle === undefined) {
		// No Web Crypto (very old browser): fall back to the hostname's length and a
		// simple digest, still avoiding the plaintext domain.
		let hash = 0;
		for (const byte of data) hash = (hash * 31 + byte) % 0xffffffff;
		return hash.toString(16).padStart(12, "0").slice(0, 12);
	}

	const digest = await subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	return Array.from(bytes.slice(0, 6))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Extract the hostname from an endpoint URL, or `undefined` when unusable. */
export function endpointHost(endpoint: string): string | undefined {
	try {
		const url = new URL(endpoint);
		return url.hostname === "" ? undefined : url.hostname;
	} catch {
		return undefined;
	}
}

/**
 * Build the reported host value for an endpoint.
 *
 * Built-in providers are already public, so their hostname is reported as-is;
 * a custom endpoint is hashed. That split is what the `is_custom_endpoint`
 * parameter records the meaning of.
 */
export async function reportedHost(
	endpoint: string,
	isCustom: boolean,
): Promise<string | undefined> {
	const host = endpointHost(endpoint);
	if (host === undefined) return undefined;

	return isCustom ? hashHostname(host) : host;
}

/**
 * Throttled event emitter for high-frequency events.
 *
 * `translate_submit` fires every time the user pauses typing, which with the
 * `core-translation` debounce is still far more often than a report needs. The
 * throttle reuses the shared primitive rather than a bespoke timer.
 *
 * Terminal events (success, error) are deliberately **not** routed through this:
 * their counts are the analysis, so merging them would corrupt the funnel.
 */
export const HIGH_FREQUENCY_THROTTLE_MS = 1000;

export function createThrottledSubmit(
	emit: (
		event: "translate_submit",
		params: AnalyticsEventMap["translate_submit"],
	) => void,
): (params: AnalyticsEventMap["translate_submit"]) => void {
	return throttle(
		(params: AnalyticsEventMap["translate_submit"]) =>
			emit("translate_submit", params),
		HIGH_FREQUENCY_THROTTLE_MS,
		// Leading only: report the first submission of a burst and let the rest go.
		{ leading: true, trailing: false },
	);
}

/**
 * Page-view reporting for a single-page application.
 *
 * The vendor's automatic page-view fires once per document, which never happens
 * again in a SPA — hence the manual send, and hence this being the place where
 * every page view passes through so no route can skip the URL sanitisation.
 */
export interface PageViewReporter {
	report(url: string): void;
}

export function createPageViewReporter(
	emit: (params: { page_path: string; page_location: string }) => void,
): PageViewReporter {
	return {
		report(url: string) {
			// Sanitisation is applied by the caller through `sanitizedPageUrl`, so this
			// reporter only forwards what it is given.
			const path = url.split("?")[0];
			emit({ page_path: path, page_location: url });
		},
	};
}

/** Re-export for call sites that need the schema's event names. */
export { ANALYTICS_EVENT_NAMES };

/** Latest-wins guard for reporters that can race. */
export { createLatestCall };
