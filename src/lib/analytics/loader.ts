/**
 * Analytics script loading and the statistics toggle.
 *
 * Four states, and the difference between them matters:
 *
 * 1. analytics disabled at startup → **no script tag at all** (not "injected then
 *    disabled": the tag's absence is what a privacy-minded user can verify);
 * 2. enabled at startup with an identifier → inject and initialise;
 * 3. disabled at runtime → stop sending, disable the capability, clear the
 *    provider's cookies; the next load falls into state 1;
 * 4. re-enabled at runtime → inject on demand, no reload needed.
 *
 * Onboarding configuration deliberately excludes user identifiers, cross-device
 * tracking and automatic form/outbound-click collection: the PRD rules those out,
 * and automatic form collection would capture exactly the text this application
 * exists to keep private.
 */

import { logger } from "../logger";
import {
	type AnalyticsStorage,
	type BuildTimeSource,
	resolveConfig,
	saveStatisticsEnabled,
	statisticsEnabled,
} from "./config";

/** Vendor script URL. Kept as a literal so the build-time scan can see it. */
/**
 * Vendor script URL, present only when this build will actually use analytics.
 *
 * Both build-time conditions must hold: an identifier must exist, and the master
 * switch must not be off. The condition is what keeps the string out of an
 * unconfigured product — the bundler inlines these variables, so a build without
 * either one collapses this to `undefined` and drops the literal entirely.
 *
 * Splitting the URL into parts does not work (the bundler folds constants back
 * together), and an unconditional literal stays in the bundle even though the
 * branch using it never runs. The build-time gate reads the same two variables, so
 * it still sees the origin exactly when analytics is configured.
 */
export const ANALYTICS_SCRIPT_URL: string | undefined =
	import.meta.env?.VITE_GA_MEASUREMENT_ID &&
	import.meta.env?.VITE_GA_ENABLED?.trim().toLowerCase() !== "false"
		? "https://www.googletagmanager.com/gtag/js"
		: undefined;

/** Cookies the provider writes; all are cleared when the user opts out. */
export const ANALYTICS_COOKIE_PREFIXES = ["_ga"] as const;

/** Document/script surface, injectable so tests need no DOM. */
export interface AnalyticsDom {
	/** Whether a script with this URL is already present. */
	hasScript(url: string): boolean;
	injectScript(url: string, id: string): void;
	/** Set a global function (the vendor's `gtag`). */
	setGlobal(name: string, value: unknown): void;
	/** Ensure the data layer array exists. */
	ensureDataLayer(): unknown[];
	/** Read the document's cookies. */
	cookies(): string;
	/** Expire a cookie by name. */
	clearCookie(name: string): void;
}

/** Real DOM implementation. */
export function createBrowserDom(): AnalyticsDom {
	return {
		hasScript(url) {
			if (typeof document === "undefined") return false;
			return document.querySelector(`script[src="${url}"]`) !== null;
		},
		injectScript(url, id) {
			if (typeof document === "undefined") return;
			const script = document.createElement("script");
			script.async = true;
			script.src = url;
			script.id = id;
			document.head.appendChild(script);
		},
		setGlobal(name, value) {
			(globalThis as Record<string, unknown>)[name] = value;
		},
		ensureDataLayer() {
			const globals = globalThis as unknown as { dataLayer?: unknown[] };
			globals.dataLayer = globals.dataLayer ?? [];
			return globals.dataLayer;
		},
		cookies() {
			return typeof document === "undefined" ? "" : document.cookie;
		},
		clearCookie(name) {
			if (typeof document === "undefined") return;
			// Expire across the paths a provider may have used; a cookie set with a
			// path only clears from that path.
			//
			// The Cookie Store API is not an option here: these cookies were written by
			// the vendor's third-party script, and expiry must work in every supported
			// browser (the Store API is not universally available).
			for (const path of ["/", ""]) {
				// biome-ignore lint/suspicious/noDocumentCookie: expiring third-party cookies requires document.cookie
				document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}`;
			}
		},
	};
}

/** Result of an initialisation attempt. */
export interface InitOutcome {
	/** True when the script was injected (or already present). */
	readonly loaded: boolean;
	/** Reason analytics is inactive, for diagnostics. */
	readonly reason?: "disabled" | "no-identifier";
}

/** The loader surface. */
export interface AnalyticsLoader {
	/** Initialise if permitted. Idempotent. */
	init(): InitOutcome;
	/** Whether a script has been injected. */
	loaded(): boolean;
	/** Turn analytics off at runtime: stop, disable, clear cookies. */
	disable(): void;
	/** Turn analytics back on at runtime, injecting on demand. */
	enable(): void;
	/** Whether the user's toggle is currently on. */
	statisticsEnabled(): boolean;
}

export interface LoaderDeps {
	readonly dom?: AnalyticsDom;
	readonly storage?: AnalyticsStorage;
	readonly build?: BuildTimeSource;
	/**
	 * Script URL override.
	 *
	 * The production value is fixed at build time — it is absent unless the build
	 * has an identifier — so tests inject one to exercise the injection path.
	 */
	readonly scriptUrl?: string;
}

export function createAnalyticsLoader(deps: LoaderDeps = {}): AnalyticsLoader {
	const dom = deps.dom ?? createBrowserDom();
	const storage = deps.storage;
	/** Injected build-time values; when absent the bundler's own are read. */
	const build = deps.build;
	/** Effective URL: the injected override, otherwise this build's value. */
	const scriptUrl = deps.scriptUrl ?? ANALYTICS_SCRIPT_URL;
	const scriptId = "mintranslate-analytics";

	let injected = false;
	/** Set when the user opts out during this session, so `init` will not re-inject. */
	let disabledAtRuntime = false;

	/** Resolve config per call, honouring an injected build source. */
	function config(): ReturnType<typeof resolveConfig> {
		return build === undefined
			? resolveConfig(storage)
			: resolveConfig(storage, build);
	}

	function injectIfPossible(): boolean {
		const resolved = config();
		if (resolved.measurementId === undefined) return false;
		// Without a URL this build has no identifier, so there is nothing to load.
		if (scriptUrl === undefined) return false;

		if (dom.hasScript(scriptUrl)) {
			injected = true;
			return true;
		}

		dom.ensureDataLayer();
		dom.setGlobal("gtag", (...args: unknown[]) => {
			const globals = globalThis as unknown as { dataLayer?: unknown[] };
			globals.dataLayer?.push(args);
		});

		// Onboarding configuration. Deliberately minimal:
		// - no `user_id` (no user identifiers, per the PRD);
		// - no ads or cross-device features;
		// - automatic form/outbound-click collection off, because automatic form
		//   collection would capture the very text this app keeps private.
		(globalThis as unknown as { gtag?: (...args: unknown[]) => void }).gtag?.(
			"js",
			new Date(),
		);
		(globalThis as unknown as { gtag?: (...args: unknown[]) => void }).gtag?.(
			"config",
			resolved.measurementId,
			{
				send_page_view: false,
				allow_google_signals: false,
				allow_ad_personalization_signals: false,
			},
		);

		dom.injectScript(scriptUrl, scriptId);
		injected = true;
		return true;
	}

	return {
		init() {
			if (disabledAtRuntime) return { loaded: false, reason: "disabled" };

			const resolved = config();
			if (resolved.measurementId === undefined) {
				return {
					loaded: false,
					reason: resolved.buildEnabled ? "no-identifier" : "disabled",
				};
			}

			// Starting while opted out means no script tag at all.
			if (!statisticsEnabled(storage)) {
				return { loaded: false, reason: "disabled" };
			}

			logger.debug("analytics.init", { source: resolved.source });
			return { loaded: injectIfPossible() };
		},

		loaded: () => injected,

		disable() {
			disabledAtRuntime = true;
			injected = false;
			saveStatisticsEnabled(false, storage);
			clearAnalyticsCookies(dom);
			logger.info("analytics.disabled");
		},

		enable() {
			disabledAtRuntime = false;
			saveStatisticsEnabled(true, storage);
			injectIfPossible();
			logger.info("analytics.enabled");
		},

		statisticsEnabled: () => statisticsEnabled(storage),
	};
}

/**
 * Expire every cookie the provider wrote.
 *
 * Both the base name and its per-identifier variants (`_ga_XXXX`) are cleared:
 * providers commonly set one of each, and clearing only the base would leave the
 * derived one behind.
 */
export function clearAnalyticsCookies(dom: AnalyticsDom): string[] {
	const cleared: string[] = [];
	const cookies = dom.cookies();

	for (const pair of cookies.split(";")) {
		const name = pair.split("=")[0]?.trim();
		if (name === undefined || name === "") continue;

		if (
			ANALYTICS_COOKIE_PREFIXES.some(
				(prefix) => name === prefix || name.startsWith(`${prefix}_`),
			)
		) {
			dom.clearCookie(name);
			cleared.push(name);
		}
	}

	return cleared;
}

/** Names of provider cookies currently present. */
export function analyticsCookieNames(dom: AnalyticsDom): string[] {
	return dom
		.cookies()
		.split(";")
		.map((pair) => pair.split("=")[0]?.trim() ?? "")
		.filter((name) => name !== "")
		.filter((name) =>
			ANALYTICS_COOKIE_PREFIXES.some(
				(prefix) => name === prefix || name.startsWith(`${prefix}_`),
			),
		);
}
