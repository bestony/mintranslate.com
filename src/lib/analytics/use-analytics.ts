/**
 * React binding for analytics.
 *
 * Three responsibilities, all of which exist in one place so no route or
 * component has to remember them:
 *
 * 1. **Initialise once** — inject the script only when an identifier resolved and
 *    the user has not opted out. Opting out means *no script tag at all*.
 * 2. **Report page views** — a single-page app never triggers the vendor's
 *    automatic page view, so each route change reports one, always through the
 *    sanitising constructor.
 * 3. **Bridge the toggle** — disabling stops sending and clears cookies; enabling
 *    injects on demand without a reload.
 *
 * A no-op when analytics is unconfigured, which is the state every intranet build
 * ships in.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MEASUREMENT_ID_KEY } from "#/lib/analytics/config";
import { ANALYTICS_MODES, type AnalyticsMode } from "#/lib/analytics/events";
import {
	type AnalyticsLoader,
	createAnalyticsLoader,
} from "#/lib/analytics/loader";
import { sanitizedPagePath, sanitizedPageUrl } from "#/lib/analytics/page-url";
import { type Analytics, createAnalytics } from "#/lib/analytics/track";
import { logger } from "#/lib/logger";

/** Resolve the entry mode from a URL's `op` value, falling back to `text`. */
export function entryModeFromUrl(url: string): AnalyticsMode {
	const match = /[?&]op=([^&]+)/.exec(url);
	const value = match?.[1];
	return ANALYTICS_MODES.find((mode) => mode === value) ?? "text";
}

/** Whether a URL carries source text, without reading it. */
export function urlHasText(url: string): boolean {
	return /[?&]text=/.test(url);
}

/** Options for the hook. */
export interface UseAnalyticsOptions {
	/** Whether at least one connection has been configured. */
	readonly byokConfigured: boolean;
	/** Current pathname, used to detect route changes. */
	readonly pathname: string;
}

/** The hook surface. */
export interface AnalyticsBinding {
	readonly analytics: Analytics;
	readonly statisticsOn: boolean;
	setStatisticsOn: (value: boolean) => void;
	/** Whether the settings field must be read-only because a deployment set it. */
	readonly idFromDeployment: boolean;
	/** The identifier a user may edit; `''` when a deployment supplies it. */
	readonly editableId: string;
}

/**
 * Wire analytics into the application shell.
 *
 * `pathname` drives page-view reporting: a change of pathname is a route change,
 * whereas the workspace's `replaceState` state updates keep the same pathname and
 * therefore correctly report nothing.
 */
export function useAnalytics(options: UseAnalyticsOptions): AnalyticsBinding {
	const { byokConfigured, pathname } = options;

	const loaderRef = useRef<AnalyticsLoader | undefined>(undefined);
	const [statisticsOn, setStatisticsOn] = useState(true);
	const [idFromDeployment, setIdFromDeployment] = useState(false);
	const [editableId, setEditableId] = useState("");

	const loader = useMemo(() => {
		const created = createAnalyticsLoader();
		loaderRef.current = created;
		return created;
	}, []);

	/**
	 * The tracker is created once and reads `byokConfigured` through a closure, so it
	 * always observes the current value without being rebuilt on every render.
	 */
	const byokRef = useRef(byokConfigured);
	byokRef.current = byokConfigured;

	const analytics = useMemo(
		() => createAnalytics({ byokConfigured: () => byokRef.current }),
		[],
	);

	// Initialise once. A build with no identifier returns immediately.
	useEffect(() => {
		const outcome = loader.init();
		setStatisticsOn(loader.statisticsEnabled());

		// Report whether the field is deployment-controlled, so the settings input
		// can be read-only rather than looking editable.
		try {
			const fromEnv = Boolean(import.meta.env?.VITE_GA_MEASUREMENT_ID);
			const enabledByBuild =
				import.meta.env?.VITE_GA_ENABLED?.trim().toLowerCase() !== "false";
			setIdFromDeployment(fromEnv && enabledByBuild);
		} catch {
			setIdFromDeployment(false);
		}

		setEditableId(localStorageSafe(MEASUREMENT_ID_KEY) ?? "");
		logger.debug("analytics.bound", {
			loaded: outcome.loaded,
			reason: outcome.reason,
		});
	}, [loader]);

	/** The app-open event fires once per session, marked in session storage. */
	const appOpenReported = useRef(false);

	useEffect(() => {
		if (appOpenReported.current) return;
		appOpenReported.current = true;

		if (typeof window === "undefined") return;

		// Session-scoped marker: a refresh in the same tab must not re-report,
		// while a new tab is a new session. Falls back to the in-memory ref when
		// session storage is unavailable.
		const marker = "mintranslate.analytics.app-open";
		try {
			if (window.sessionStorage.getItem(marker) === "1") return;
			window.sessionStorage.setItem(marker, "1");
		} catch {
			// No session storage: the ref guard above is the fallback.
		}

		analytics.track("app_open", {
			entry_mode: entryModeFromUrl(window.location.search),
			has_url_text: urlHasText(window.location.search),
		});
	}, [analytics]);

	// Page views. Reported per distinct pathname; the workspace's state-only URL
	// updates keep the pathname unchanged and therefore report nothing.
	const lastPath = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (lastPath.current === pathname) return;
		lastPath.current = pathname;

		// Route to the vendor's own reporting function through the tracked event
		// name, but with the sanitised URL: this is the path that must never carry
		// source text.
		const safeUrl = sanitizedPageUrl(window.location.href);
		const safePath = sanitizedPagePath(window.location.href);

		reportPageView(analytics, safePath, safeUrl);
	}, [analytics, pathname]);

	const setStatistics = useCallback(
		(value: boolean) => {
			setStatisticsOn(value);
			if (value) loader.enable();
			else loader.disable();
		},
		[loader],
	);

	return {
		analytics,
		statisticsOn,
		setStatisticsOn: setStatistics,
		idFromDeployment,
		editableId,
	};
}

/** Read a storage slot without throwing. */
function localStorageSafe(key: string): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

/**
 * Send a page-view event.
 *
 * Kept separate from the tracked business events because it is not one of the nine
 * documented events: it is the vendor's own reporting call, routed through the same
 * `gtag` global with an already-sanitised URL.
 */
function reportPageView(
	analytics: Analytics,
	pagePath: string,
	pageLocation: string,
): void {
	if (!analytics.enabled()) return;

	try {
		const globals = globalThis as unknown as {
			gtag?: (...args: unknown[]) => void;
		};
		globals.gtag?.("event", "page_view", {
			page_path: pagePath,
			page_location: pageLocation,
		});
	} catch (error) {
		// A reporting failure must not reach the caller.
		logger.debug("analytics.pageview.failed", { error });
	}
}
