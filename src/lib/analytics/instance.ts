/**
 * Application-wide analytics instance.
 *
 * Why this is module scope rather than a hook per component: analytics must be
 * initialised **once per page load**, and the page-view reporter has to observe
 * route changes. When each route mounted its own hook, the script was only
 * injected on the route that happened to call it (settings), so every other route
 * reported nothing — the defect this module fixes.
 *
 * It is deliberately not a React context: the tracker is not render data. It is a
 * single side-effecting object with a subscription, and the settings page reads
 * its state through `useSyncExternalStore` below.
 */

import { type Analytics, createAnalytics } from "#/lib/analytics/track";
import { isBuiltinProvider } from "#/lib/connections/model";
import {
	CONNECTIONS_KEY,
	deserializeConnections,
} from "#/lib/connections/storage";

/** The one tracker for the page. Created lazily so nothing runs on import. */
let instance: Analytics | undefined;

/** The page's analytics entry point, created on first use. */
export function analytics(): Analytics {
	instance ??= createAnalytics({ byokConfigured: byokConfigured });
	return instance;
}

/**
 * Whether at least one connection is usable.
 *
 * Read lazily from storage so the tracker does not need rebuilding when the user
 * configures a connection. Absent storage (prerender, tests) counts as
 * unconfigured.
 */
function byokConfigured(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return hasConfiguredExternalConnection(
			window.localStorage.getItem(CONNECTIONS_KEY),
		);
	} catch {
		return false;
	}
}

/** Whether stored connections include at least one tested external provider. */
export function hasConfiguredExternalConnection(raw: string | null): boolean {
	return deserializeConnections(raw).value.some(
		(connection) =>
			connection.status === "ok" && !isBuiltinProvider(connection.provider),
	);
}

/** Replace the instance. For tests only. */
export function resetAnalyticsForTests(next?: Analytics): void {
	instance = next;
}

/** Listeners for the settings toggle, so the field reflects the live value. */
const listeners = new Set<() => void>();

/** Notify subscribers that the statistics toggle changed. */
export function notifyStatisticsChanged(): void {
	for (const listener of listeners) listener();
}

/** Subscribe to statistics-toggle changes; returns an unsubscribe function. */
export function subscribeStatistics(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
