import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { resolveConfig } from "#/lib/analytics/config";
import { ANALYTICS_SCRIPT_URL } from "#/lib/analytics/loader";
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
		<output className="block border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-amber-900 text-sm dark:border-amber-500/40 dark:bg-amber-950/60 dark:text-amber-100">
			当前环境不支持安装到桌面与离线能力，因为页面未通过 HTTPS 提供。请改用
			HTTPS 访问以启用这些能力。
		</output>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN">
			<head>
				<HeadContent />
			</head>
			<body>
				<InsecureContextNotice />
				{children}
				<Scripts />
			</body>
		</html>
	);
}
