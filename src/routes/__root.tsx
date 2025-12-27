import {
	createRootRoute,
	HeadContent,
	Link,
	Scripts,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AppFooter } from "@/components/AppFooter";
import { AppI18nHydrator } from "@/components/AppI18nHydrator";
import { AppSettingsHydrator } from "@/components/AppSettingsHydrator";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { appI18n, normalizeAppLanguage, toHtmlLang } from "@/lib/app-i18n";

import appCss from "../styles.css?url";

const GA_ID = "G-GCEXSQSG1G";
const ADS_CLIENT_ID = "ca-pub-9877802927933140";
const MARKETING_CONSENT_KEY = "mintranslate:consent:marketing";
const SEO_TITLE =
	"MinTranslate - Google Translator Alternative & DeepL Translator Alternative";
const SEO_DESCRIPTION =
	"MinTranslate is a minimal AI translator, a Google Translator Alternative & DeepL Translator Alternative.";

type GtagArgs = [string, ...unknown[]];

declare global {
	interface Window {
		dataLayer?: GtagArgs[];
		gtag?: (...args: GtagArgs) => void;
	}
}

function hasMarketingConsent() {
	if (typeof window === "undefined") return false;

	try {
		const consent = window.localStorage.getItem(MARKETING_CONSENT_KEY);
		return consent === "granted" || consent === "true";
	} catch {
		return false;
	}
}

export const Route = createRootRoute({
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
				title: SEO_TITLE,
			},
			{
				name: "description",
				content: SEO_DESCRIPTION,
			},
			{
				property: "og:title",
				content: SEO_TITLE,
			},
			{
				property: "og:description",
				content: SEO_DESCRIPTION,
			},
			{
				name: "twitter:card",
				content: "summary",
			},
			{
				name: "twitter:title",
				content: SEO_TITLE,
			},
			{
				name: "twitter:description",
				content: SEO_DESCRIPTION,
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),

	shellComponent: RootDocument,
	notFoundComponent: RootNotFound,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	const router = useRouter();
	const cspNonce = router.options.ssr?.nonce;
	const { lang } = useParams({ strict: false });
	const routeLang = normalizeAppLanguage(lang);
	const locale = routeLang ?? "en";
	const htmlLang = toHtmlLang(locale);
	const [allowTracking, setAllowTracking] = useState(false);

	useEffect(() => {
		if (!import.meta.env.PROD) return;

		const updateConsent = () => {
			setAllowTracking(hasMarketingConsent());
		};

		updateConsent();
		window.addEventListener("storage", updateConsent);

		return () => {
			window.removeEventListener("storage", updateConsent);
		};
	}, []);

	useEffect(() => {
		if (!allowTracking) return;
		if (document.getElementById("ga-gtag")) return;

		const gtagScript = document.createElement("script");
		gtagScript.async = true;
		gtagScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
		gtagScript.id = "ga-gtag";
		document.head.appendChild(gtagScript);

		const dataLayer = window.dataLayer ?? [];
		// Persist the dataLayer on window for gtag to use globally.
		if (!window.dataLayer) window.dataLayer = dataLayer;
		const gtag: (...args: GtagArgs) => void = (...args) => {
			dataLayer.push(args);
		};

		window.gtag = gtag;
		gtag("js", new Date());
		gtag("config", GA_ID);
	}, [allowTracking]);

	return (
		<html lang={htmlLang} suppressHydrationWarning>
			<head>
				<HeadContent />
				{allowTracking ? (
					<script
						async
						src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADS_CLIENT_ID}`}
						crossOrigin="anonymous"
					/>
				) : null}
			</head>
			<body className="min-h-screen">
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					enableSystem
					nonce={cspNonce}
				>
					<I18nextProvider i18n={appI18n}>
						<AppI18nHydrator routeLang={routeLang ?? undefined} />
						<AppSettingsHydrator />
						{children}
						<AppFooter />
						<Toaster richColors closeButton />
					</I18nextProvider>
				</ThemeProvider>
				<Devtools />
				<Scripts />
			</body>
		</html>
	);
}

function Devtools() {
	const [render, setRender] = useState<(() => React.ReactNode) | null>(null);

	useEffect(() => {
		if (!import.meta.env.DEV) return;

		void (async () => {
			const [
				{ TanStackDevtools },
				{ TanStackRouterDevtoolsPanel },
				aiDevtools,
			] = await Promise.all([
				import("@tanstack/react-devtools"),
				import("@tanstack/react-router-devtools"),
				import("@tanstack/react-ai-devtools"),
			]);

			setRender(() => () => (
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						aiDevtools.aiDevtoolsPlugin(),
					]}
					eventBusConfig={{
						connectToServerBus: true,
					}}
				/>
			));
		})();
	}, []);

	if (!render) return null;

	return render();
}

function RootNotFound() {
	const { t, i18n } = useTranslation();
	const { lang } = useParams({ strict: false });
	const docsLang = normalizeAppLanguage(lang ?? i18n.resolvedLanguage) ?? "en";

	return (
		<div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
			<div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-10 sm:px-6 lg:px-10">
				<div className="space-y-2">
					<h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
						{t("notFound.title")}
					</h1>
					<p className="text-sm text-muted-foreground">
						{t("notFound.description")}
					</p>
				</div>

				<div className="flex flex-wrap gap-2">
					<Button asChild>
						<Link to="/">{t("notFound.actions.goHome")}</Link>
					</Button>
					<Button asChild variant="outline">
						<Link to="/$lang/docs/$" params={{ lang: docsLang, _splat: "" }}>
							{t("notFound.actions.openDocs")}
						</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}
