import { createFileRoute, Link } from "@tanstack/react-router";

import { TranslationWorkspace } from "#/components/translation/TranslationWorkspace";

export const Route = createFileRoute("/")({ component: Home });

/**
 * Translation workspace route.
 *
 * The workspace is now the application's home. It reads its state from the URL
 * and drives the translation controller; see the component for how the pieces
 * compose.
 *
 * No loader: the shell is prerendered without a backend, so the route must render
 * from client state alone.
 */
function Home() {
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
						<Link to="/settings" className="nav-link">
							设置
						</Link>
					</nav>
				</div>
			</header>
			<TranslationWorkspace />
		</>
	);
}
