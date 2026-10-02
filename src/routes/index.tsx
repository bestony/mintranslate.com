import { createFileRoute } from "@tanstack/react-router";

import { SiteFooter, SiteHeader } from "#/components/SiteChrome";
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
			<SiteHeader />
			{/* A `main` landmark: the other two routes have one, and its absence on the
			    home route was the only accessibility audit failure. */}
			<main className="flex min-h-0 flex-1 flex-col">
				<TranslationWorkspace />
			</main>
			<SiteFooter />
		</>
	);
}
