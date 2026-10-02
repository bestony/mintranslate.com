import { createFileRoute, Link } from "@tanstack/react-router";

import { HistoryPage } from "#/components/history/HistoryPage";

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
			<header className="border-line border-b bg-header-bg">
				<div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3 md:px-6">
					<Link to="/" className="display-title font-bold text-lg">
						MinTranslate
					</Link>
					<nav className="ml-auto flex items-center gap-4 text-sm">
						<Link to="/" className="nav-link">
							翻译
						</Link>
						<Link to="/history" className="nav-link">
							历史
						</Link>
						<Link to="/settings" className="nav-link">
							设置
						</Link>
					</nav>
				</div>
			</header>
			<HistoryPage />
		</>
	);
}
