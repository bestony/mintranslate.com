import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PwaStatus } from "#/components/pwa/PwaStatus";
import { resolveConfig } from "#/lib/analytics/config";
import { ANALYTICS_SCRIPT_URL } from "#/lib/analytics/loader";
import { useRootAnalytics } from "#/lib/analytics/root";
import { withBase } from "#/lib/base-path";
import { shouldShowInsecureContextNotice } from "#/lib/secure-context";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "MinTranslate",
			},
			{
				name: "description",
				content:
					"A self-hosted AI translation workbench. Bring your own model endpoint; text, images, documents and webpages stay under your control.",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			{
				rel: "manifest",
				href: withBase("/manifest.webmanifest"),
			},
			{
				rel: "apple-touch-icon",
				href: withBase("/apple-touch-icon.png"),
			},
			{
				rel: "icon",
				type: "image/svg+xml",
				href: withBase("/icon.svg"),
			},
			// Declared only when an identifier resolved at build time. An unconfigured
			// build therefore contains no analytics URL at all, which is what the
			// build-time gate asserts and what an intranet deployment relies on.
			...analyticsScript(),
		],
	}),
	shellComponent: RootDocument,
});

/**
 * Analytics resource hint, or nothing.
 *
 * The loader performs the actual injection; this entry only lets the browser warm
 * the connection early. It is absent unless the build has an identifier, so an
 * unconfigured product contains no analytics origin at all.
 */
function analyticsScript(): Array<{ rel: string; href: string }> {
	if (ANALYTICS_SCRIPT_URL === undefined) return [];
	if (resolveConfig().measurementId === undefined) return [];

	return [{ rel: "dns-prefetch", href: ANALYTICS_SCRIPT_URL }];
}

/**
 * Whether the page runs in a secure context.
 *
 * `undefined` means "not resolved yet". The state starts unresolved because the
 * application shell is prerendered at build time, where there is no `window`;
 * rendering the notice only after hydration keeps the prerendered shell and the
 * first client render identical.
 */
type SecureContextState = boolean | undefined;

/**
 * Persistent notice shown when the page is not in a secure context.
 *
 * Service worker registration and installation both require a secure context,
 * so the application cannot offer offline or install capability there. The
 * notice is deliberately not dismissible: the limitation lasts as long as the
 * page is served over an insecure origin, and a dismissible notice would let
 * the capability gap look like a defect (see spec `spa-shell`).
 */
function InsecureContextNotice() {
	const [isSecureContext, setIsSecureContext] =
		useState<SecureContextState>(undefined);

	useEffect(() => {
		setIsSecureContext(window.isSecureContext);
	}, []);

	if (!shouldShowInsecureContextNotice(isSecureContext)) {
		return null;
	}

	return (
		<output className="block border-b border-border bg-surface px-4 py-2 text-foreground text-sm ">
			当前环境不支持安装到桌面与离线能力，因为页面未通过 HTTPS 提供。请改用
			HTTPS 访问以启用这些能力。
		</output>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	// Analytics belongs to the shell: the script must be injected once whichever
	// route the user landed on, and page views must fire on every route change.
	// Mounting this per-route is what previously limited analytics to settings.
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	useRootAnalytics(pathname);

	/**
	 * Route content is withheld from the first client render.
	 *
	 * The SPA shell is prerendered while the router is still suspended, so the
	 * served body contains an empty Suspense placeholder rather than the page
	 * markup. On the client the router can already be resolved by the time React
	 * hydrates — the home route's chunk is `modulepreload`ed, and a warm HTTP cache
	 * resolves it before first paint. React then finds page markup where the server
	 * had a placeholder and reports `Minified React error #418`, discarding the
	 * prerendered tree.
	 *
	 * Rendering the page only after mount makes the first client render match what
	 * the server sent. The page then appears as a normal update.
	 */
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	return (
		<html lang="zh-CN">
			<head>
				<HeadContent />
			</head>
			<body>
				<InsecureContextNotice />
				{/* Update prompt, offline notice. Mounted in the shell so it appears on
				    every route without each page remembering it. */}
				<PwaStatus />
				{mounted ? children : null}
				<Scripts />
			</body>
		</html>
	);
}
