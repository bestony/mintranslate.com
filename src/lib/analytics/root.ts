/**
 * Root analytics initialisation and page views.
 *
 * Mounted once, in the shell. Two things happen here and nowhere else:
 *
 * 1. **The script is injected once** on the first page load, whatever route the
 *    user landed on. Doing this per-route is what caused analytics to be active
 *    only on the settings page.
 * 2. **Page views are reported on every route change**, including the first load.
 *    A single-page app never triggers the vendor's automatic page view.
 *
 * The tracker instance itself lives in `./instance`, so components that emit
 * business events share exactly this one object.
 */

import { useEffect, useRef } from "react";

import { MEASUREMENT_ID_KEY } from "#/lib/analytics/config";
import { ANALYTICS_MODES, type AnalyticsMode } from "#/lib/analytics/events";
import { analytics } from "#/lib/analytics/instance";
import { createAnalyticsLoader } from "#/lib/analytics/loader";
import { sanitizedPagePath, sanitizedPageUrl } from "#/lib/analytics/page-url";
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

/**
 * Set up analytics for the whole application.
 *
 * `pathname` drives page-view reporting: a change of pathname is a route change,
 * whereas the workspace's `replaceState` state updates keep the same pathname and
 * therefore correctly report nothing.
 */
export function useRootAnalytics(pathname: string): void {
	const tracker = analytics();
	const initialised = useRef(false);

	// Initialise once per page load. A build with no identifier does nothing.
	useEffect(() => {
		if (initialised.current) return;
		initialised.current = true;

		const loader = createAnalyticsLoader();
		const outcome = loader.init();
		logger.debug("analytics.init.root", {
			loaded: outcome.loaded,
			reason: outcome.reason,
		});

		// The app-open event fires once per session, marked in session storage.
		if (typeof window === "undefined") return;

		const marker = "mintranslate.analytics.app-open";
		try {
			if (window.sessionStorage.getItem(marker) === "1") return;
			window.sessionStorage.setItem(marker, "1");
		} catch {
			// No session storage: report once per page load instead.
		}

		tracker.track("app_open", {
			entry_mode: entryModeFromUrl(window.location.search),
			has_url_text: urlHasText(window.location.search),
		});
	}, [tracker]);

	// Page views. Reported per distinct pathname; the workspace's state-only URL
	// updates keep the pathname unchanged and therefore report nothing.
	const lastPath = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (lastPath.current === pathname) return;
		lastPath.current = pathname;

		reportPageView(
			sanitizedPagePath(window.location.href),
			sanitizedPageUrl(window.location.href),
		);
	}, [pathname]);
}

/**
 * Send a page-view event.
 *
 * The vendor's own reporting call, routed through the same `gtag` global with an
 * already-sanitised URL — this is the path that must never carry source text.
 */
function reportPageView(pagePath: string, pageLocation: string): void {
	const tracker = analytics();
	if (!tracker.enabled()) return;

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

/** Re-exported for the settings page, which reads but never re-initialises. */
export { MEASUREMENT_ID_KEY };
