import { createRouter } from "@tanstack/react-router";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

function readCspNonce() {
	if (typeof document === "undefined") return undefined;
	return document
		.querySelector("meta[property='csp-nonce']")
		?.getAttribute("content");
}

// Create a new router instance
export const getRouter = () => {
	const router = createRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreloadStaleTime: 0,
	});

	const cspNonce = readCspNonce();
	if (cspNonce) {
		router.update({
			ssr: {
				...(router.options.ssr ?? {}),
				nonce: cspNonce,
			},
		});
	}

	return router;
};
