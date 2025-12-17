import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import {
	ArrowLeftRightIcon,
	BookOpenIcon,
	CopyIcon,
	InfoIcon,
	LanguagesIcon,
	Settings2Icon,
	Trash2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { translateHistoryCollection } from "@/db/translateHistoryCollection";
import {
	I18N_KEY_PREFIX,
	isI18nKey,
	normalizeAppLanguage,
	setAppLanguage,
} from "@/lib/app-i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { i18n as docsI18n } from "@/lib/i18n";
import {
	type Lang,
	setLeftText,
	setSourceLang,
	setTargetLang,
	startTranslateEffects,
	stopTranslateEffects,
	swapTranslateLanguages,
	TRANSLATE_LANGS,
	translateStore,
	triggerTranslateNow,
} from "@/stores/translateStore";

export const Route = createFileRoute("/")({ component: App });

function App() {
	const { t, i18n } = useTranslation();

	const uiLang = normalizeAppLanguage(i18n.resolvedLanguage) ?? "zh";
	const docsLang = (() => {
		const resolvedLanguage = i18n.resolvedLanguage?.toLowerCase() ?? "";
		const matched = docsI18n.languages.find(
			(lang) =>
				resolvedLanguage === lang || resolvedLanguage.startsWith(`${lang}-`),
		);
		return matched ?? docsI18n.defaultLanguage;
	})();
	const langLabel: Record<Lang, string> = {
		zh: t("common.languages.zh"),
		en: t("common.languages.en"),
		fr: t("common.languages.fr"),
		ja: t("common.languages.ja"),
		es: t("common.languages.es"),
	};

	const leftLang = useStore(translateStore, (state) => state.leftLang);
	const rightLang = useStore(translateStore, (state) => state.rightLang);

	const leftText = useStore(translateStore, (state) => state.leftText);
	const rightText = useStore(translateStore, (state) => state.rightText);
	const providers = useStore(translateStore, (state) => state.providers);
	const defaultProviderId = useStore(
		translateStore,
		(state) => state.defaultProviderId,
	);
	const isTranslating = useStore(
		translateStore,
		(state) => state.isTranslating,
	);
	const translateError = useStore(
		translateStore,
		(state) => state.translateError,
	);

	useEffect(() => {
		startTranslateEffects();
		return () => stopTranslateEffects();
	}, []);

	const defaultProvider =
		providers.find((p) => p.id === defaultProviderId) ?? null;
	const canTranslateWithDefaultProvider = (() => {
		if (!defaultProvider) return false;
		if (defaultProvider.type === "ollama") return true;
		return Boolean(defaultProvider.apiKey?.trim());
	})();

	return (
		<div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
			<div className="mx-auto container px-4 py-10 sm:px-6 lg:px-10">
				<header className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-2">
						<h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
							MinTranslate
						</h1>
						<p className="text-sm text-muted-foreground">
							{t("home.subtitle")}
						</p>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<Button asChild type="button" variant="outline">
							<Link to="/$lang/docs/$" params={{ lang: docsLang, _splat: "" }}>
								<BookOpenIcon />
								{t("nav.docs")}
							</Link>
						</Button>

						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button type="button" variant="outline">
									<LanguagesIcon />
									{t(`common.languages.${uiLang}`)}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => void setAppLanguage("en")}>
									{t("common.languages.en")}
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => void setAppLanguage("zh")}>
									{t("common.languages.zh")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>

						<Button
							asChild
							type="button"
							variant={defaultProvider ? "outline" : "default"}
						>
							<Link to="/settings">
								<Settings2Icon />
								{defaultProvider
									? t("home.ui.buttons.manageProvider")
									: t("home.ui.buttons.setupProvider")}
							</Link>
						</Button>
						<ThemeToggle />
					</div>
				</header>

				<Separator className="my-8" />

				<div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
					<Card className="gap-4 py-4">
						<CardHeader className="border-b py-0">
							<div className="space-y-1">
								<CardTitle className="text-base">
									{t("home.translator.source.title")}
								</CardTitle>
								<CardDescription>
									{t("home.translator.source.description", {
										language: langLabel[leftLang],
									})}
								</CardDescription>
							</div>

							<CardAction className="flex items-center gap-2">
								<Select
									value={leftLang}
									onValueChange={(value) => setSourceLang(value as Lang)}
								>
									<SelectTrigger size="sm" className="min-w-[112px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent align="end">
										{TRANSLATE_LANGS.map((lang) => (
											<SelectItem
												key={lang}
												value={lang}
												disabled={lang === rightLang}
											>
												{langLabel[lang]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>

								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											onClick={() => swapTranslateLanguages()}
											aria-label={t("home.translator.source.swapLanguages")}
										>
											<ArrowLeftRightIcon />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom" sideOffset={8}>
										{t("home.translator.source.swapLanguages")}
									</TooltipContent>
								</Tooltip>

								<Select
									value={rightLang}
									onValueChange={(value) => setTargetLang(value as Lang)}
								>
									<SelectTrigger size="sm" className="min-w-[112px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent align="end">
										{TRANSLATE_LANGS.map((lang) => (
											<SelectItem
												key={lang}
												value={lang}
												disabled={lang === leftLang}
											>
												{langLabel[lang]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</CardAction>
						</CardHeader>

						<CardContent className="flex flex-1 flex-col pt-0">
							<Textarea
								value={leftText}
								onChange={(e) => setLeftText(e.target.value)}
								onKeyDown={(e) => {
									if (
										e.key === "Enter" &&
										(e.metaKey || e.ctrlKey) &&
										canTranslateWithDefaultProvider
									) {
										triggerTranslateNow();
									}
								}}
								placeholder={t("home.translator.source.placeholder")}
								className="h-[340px] resize-none text-sm leading-relaxed md:h-[460px]"
							/>
						</CardContent>

						<CardFooter className="justify-between gap-3 border-t pt-4">
							<p className="text-xs text-muted-foreground">
								{t("common.units.characters", { count: leftText.length })}
							</p>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setLeftText("")}
									disabled={!leftText}
								>
									<Trash2Icon />
									{t("home.translator.source.clear")}
								</Button>

								<Tooltip>
									<TooltipTrigger asChild>
										<span>
											<Button
												type="button"
												size="sm"
												onClick={() => triggerTranslateNow()}
												disabled={
													!leftText.trim() || !canTranslateWithDefaultProvider
												}
											>
												{t("home.translator.source.translateNow")}
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent side="top" sideOffset={8}>
										<span className="inline-flex items-center gap-1">
											{t("common.shortcuts.label")}
											<KbdGroup>
												<Kbd>⌘</Kbd>
												<Kbd>Enter</Kbd>
											</KbdGroup>{" "}
											/{" "}
											<KbdGroup>
												<Kbd>Ctrl</Kbd>
												<Kbd>Enter</Kbd>
											</KbdGroup>
										</span>
									</TooltipContent>
								</Tooltip>
							</div>
						</CardFooter>
					</Card>

					<Card className="gap-4 py-4">
						<CardHeader className="border-b py-0">
							<div className="space-y-1">
								<CardTitle className="text-base">
									{t("home.translator.target.title")}
								</CardTitle>
								<CardDescription>
									{t("home.translator.target.description", {
										source: langLabel[leftLang],
										target: langLabel[rightLang],
									})}
								</CardDescription>
							</div>

							<CardAction className="flex items-center gap-2">
								{isTranslating ? (
									<Badge variant="secondary" className="gap-2">
										<Spinner className="size-3" />
										{t("common.status.translating")}
									</Badge>
								) : null}

								<Tooltip>
									<TooltipTrigger asChild>
										<span>
											<Button
												type="button"
												variant="outline"
												size="icon-sm"
												onClick={() => copyToClipboard(rightText, t)}
												disabled={!rightText.trim()}
												aria-label={t("home.translator.target.copyTranslation")}
											>
												<CopyIcon />
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent side="bottom" sideOffset={8}>
										{t("home.translator.target.copyTranslation")}
									</TooltipContent>
								</Tooltip>
							</CardAction>
						</CardHeader>

						<CardContent className="flex flex-1 flex-col pt-0">
							<Textarea
								value={rightText}
								readOnly
								placeholder={t("home.translator.target.placeholder")}
								className="h-[340px] resize-none text-sm leading-relaxed md:h-[460px]"
							/>
						</CardContent>

						<CardFooter className="justify-between gap-3 border-t pt-4">
							<p className="text-xs text-muted-foreground">
								{t("common.units.characters", { count: rightText.length })}
							</p>

							<Button asChild type="button" variant="ghost" size="sm">
								<Link to="/settings">
									<Settings2Icon />
									{t("home.ui.buttons.provider")}
								</Link>
							</Button>
						</CardFooter>
					</Card>
				</div>

				<div className="mt-6 space-y-3">
					{translateError ? (
						<Alert variant="destructive">
							<TriangleAlertIcon />
							<AlertTitle>{t("home.alerts.translateFailed.title")}</AlertTitle>
							<AlertDescription>
								{isI18nKey(translateError)
									? t(translateError.slice(I18N_KEY_PREFIX.length))
									: translateError}
							</AlertDescription>
						</Alert>
					) : null}

					{leftText.trim() && !canTranslateWithDefaultProvider ? (
						<Alert>
							<InfoIcon />
							<AlertTitle>{t("home.alerts.providerRequired.title")}</AlertTitle>
							<AlertDescription>
								{t("home.alerts.providerRequired.description")}
							</AlertDescription>
						</Alert>
					) : null}
				</div>

				<TranslationHistorySection />
			</div>
		</div>
	);
}

function TranslationHistorySection() {
	const [isClient, setIsClient] = useState(false);

	useEffect(() => {
		setIsClient(true);
	}, []);

	if (!isClient) return null;

	return <TranslationHistorySectionClient />;
}

function TranslationHistorySectionClient() {
	const { t, i18n } = useTranslation();
	const uiLang = normalizeAppLanguage(i18n.resolvedLanguage) ?? "zh";
	const langLabel: Record<Lang, string> = {
		zh: t("common.languages.zh"),
		en: t("common.languages.en"),
		fr: t("common.languages.fr"),
		ja: t("common.languages.ja"),
		es: t("common.languages.es"),
	};

	const { data, isLoading } = useLiveQuery(() => translateHistoryCollection);

	const items = (data ?? [])
		.slice()
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, 3);

	const total = data?.length ?? 0;
	const subtitle =
		total > 3
			? t("home.history.caption.last3")
			: t("home.history.caption.total", { count: total });

	return (
		<Card className="mt-10 gap-4 py-4">
			<CardHeader className="border-b py-0">
				<div className="space-y-1">
					<CardTitle className="text-base">
						{t("home.history.title")}{" "}
						<span className="text-sm font-normal text-muted-foreground">
							({subtitle})
						</span>
					</CardTitle>
					<CardDescription>{t("home.history.description")}</CardDescription>
				</div>

				<CardAction className="flex items-center gap-2">
					{total ? (
						<Button asChild type="button" variant="outline" size="sm">
							<Link to="/history">{t("home.history.actions.viewAll")}</Link>
						</Button>
					) : (
						<Button type="button" variant="outline" size="sm" disabled>
							{t("home.history.actions.viewAll")}
						</Button>
					)}
				</CardAction>
			</CardHeader>

			<CardContent className="pt-0">
				{isLoading ? (
					<p className="text-sm text-muted-foreground">
						{t("common.status.loading")}
					</p>
				) : null}

				{!isLoading && items.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t("home.history.empty")}
					</p>
				) : null}

				{items.length ? (
					<ul className="space-y-4">
						{items.map((item) => (
							<li key={item.id} className="bg-card rounded-lg border p-4">
								<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
									<span>
										{new Date(item.createdAt).toLocaleString(
											uiLang === "zh" ? "zh-CN" : "en-US",
										)}
									</span>

									<div className="flex items-center gap-2">
										<span>
											{langLabel[item.sourceLang]} →{" "}
											{langLabel[item.targetLang]}
										</span>

										<Tooltip>
											<TooltipTrigger asChild>
												<span>
													<Button
														type="button"
														variant="outline"
														size="icon-sm"
														onClick={() => copyToClipboard(item.sourceText, t)}
														aria-label={t("home.ui.tooltips.copySource")}
													>
														<CopyIcon />
													</Button>
												</span>
											</TooltipTrigger>
											<TooltipContent side="bottom" sideOffset={8}>
												{t("home.ui.tooltips.copySource")}
											</TooltipContent>
										</Tooltip>

										<Tooltip>
											<TooltipTrigger asChild>
												<span>
													<Button
														type="button"
														variant="outline"
														size="icon-sm"
														onClick={() =>
															copyToClipboard(item.translatedText, t)
														}
														aria-label={t("home.ui.tooltips.copyTranslation")}
													>
														<CopyIcon />
													</Button>
												</span>
											</TooltipTrigger>
											<TooltipContent side="bottom" sideOffset={8}>
												{t("home.ui.tooltips.copyTranslation")}
											</TooltipContent>
										</Tooltip>
									</div>
								</div>

								<div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
									<div className="space-y-2">
										<p className="text-xs font-semibold text-muted-foreground">
											{langLabel[item.sourceLang]}
										</p>
										<pre className="whitespace-pre-wrap break-words text-sm text-foreground">
											{item.sourceText}
										</pre>
									</div>
									<div className="space-y-2">
										<p className="text-xs font-semibold text-muted-foreground">
											{langLabel[item.targetLang]}
										</p>
										<pre className="whitespace-pre-wrap break-words text-sm text-foreground">
											{item.translatedText}
										</pre>
									</div>
								</div>
							</li>
						))}
					</ul>
				) : null}
			</CardContent>
		</Card>
	);
}
