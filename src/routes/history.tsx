import { createFileRoute } from "@tanstack/react-router";
import { HistoryPage } from "#/components/history/HistoryPage";
import { SiteFooter, SiteHeader } from "#/components/SiteChrome";

export const Route = createFileRoute("/history")({ component: HistoryRoute });

/**
 * History route.
 *
 * Uses the same shell as the workspace and settings so navigation and the
 * responsive breakpoints behave identically on all three pages.
 *
 * No loader: the page reads IndexedDB, which is unavailable while prerendering
 * the shell, so it must render from client state.
 */
function HistoryRoute() {
	return (
		<>
			<SiteHeader />
			<HistoryPage />
			<SiteFooter />
		</>
	);
}
