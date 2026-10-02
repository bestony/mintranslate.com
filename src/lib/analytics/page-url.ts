/**
 * Analytics URL sanitisation.
 *
 * The highest-risk path in this whole feature: a page-view report carries the
 * current URL by default, and this application puts the **source text** in that
 * URL's `text` parameter. Without sanitisation, every translation the user types
 * would be sent to the analytics provider.
 *
 * There is exactly one function that produces a reportable URL, and both the
 * first-load report and every route-change report go through it. That is
 * deliberate: the failure mode being guarded against is "a second reporting path
 * was added and forgot to strip", which a single constructor makes impossible.
 *
 * Stripping reuses the existing `stripSensitiveParams` from `url-state` — the
 * entry point the workspace spec already nominates for this job — so the
 * parameter list lives in one place.
 */

import { stripSensitiveParams } from "../url-state";

/**
 * Turn a URL into one that is safe to report.
 *
 * Removes the source-text parameter as a whole parameter (never truncated: a
 * shortened paragraph is still the user's content). Other parameters survive, so
 * the reports still distinguish language directions and modes.
 */
export function sanitizedPageUrl(url: string): string {
	return stripSensitiveParams(url);
}

/**
 * The path portion of a safe URL.
 *
 * Derived from the sanitised URL rather than the original, so a path cannot smuggle
 * a query string through.
 */
export function sanitizedPagePath(url: string): string {
	const sanitized = sanitizedPageUrl(url);
	const withoutQuery = sanitized.split("?")[0];
	return withoutQuery.split("#")[0];
}

/** Whether a URL still carries source text. Used by tests and by the app_open check. */
export function carriesVisibleText(url: string): boolean {
	return url !== sanitizedPageUrl(url);
}
