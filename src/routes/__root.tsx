import {
	createRootRoute,
	HeadContent,
	Link,
	Scripts,
	useParams,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { AppFooter } from "@/components/AppFooter";
import { AppI18nHydrator } from "@/components/AppI18nHydrator";
import { AppSettingsHydrator } from "@/components/AppSettingsHydrator";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { appI18n, normalizeAppLanguage, toHtmlLang } from "@/lib/app-i18n";

import appCss from "../styles.css?url";

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
				title: "MinTranslate",
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
	const { lang } = useParams({ strict: false });
	const routeLang = normalizeAppLanguage(lang);
	const locale = routeLang ?? "zh";
	const htmlLang = toHtmlLang(locale);

	return (
		<html lang={htmlLang} suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body className="min-h-screen">
				<I18nextProvider i18n={appI18n}>
					<AppI18nHydrator routeLang={routeLang ?? undefined} />
					<AppSettingsHydrator />
					{children}
					<AppFooter />
					<Toaster richColors closeButton />
				</I18nextProvider>
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
