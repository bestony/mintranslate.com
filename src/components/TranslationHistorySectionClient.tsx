import { useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { translateHistoryCollection } from "@/db/translateHistoryCollection";
import { normalizeAppLanguage } from "@/lib/app-i18n";
import { copyToClipboard } from "@/lib/clipboard";
import type { Lang } from "@/stores/translateStore";

export default function TranslationHistorySectionClient() {
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

	const { items, total, subtitle } = useMemo(() => {
		const sorted = (data ?? [])
			.slice()
			.sort((a, b) => b.createdAt - a.createdAt);
		const totalCount = sorted.length;
		const last3 = sorted.slice(0, 3);
		const caption =
			totalCount > 3
				? t("home.history.caption.last3")
				: t("home.history.caption.total", { count: totalCount });

		return {
			items: last3,
			total: totalCount,
			subtitle: caption,
		};
	}, [data, t]);

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
