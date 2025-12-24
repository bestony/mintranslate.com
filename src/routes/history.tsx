import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	CopyIcon,
	DownloadIcon,
	HomeIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ThemeToggle } from "@/components/ThemeToggle";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	type TranslateHistoryItem,
	translateHistoryCollection,
} from "@/db/translateHistoryCollection";
import { normalizeAppLanguage, setAppLanguage } from "@/lib/app-i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { useLangLabels } from "@/lib/language-labels";

export const Route = createFileRoute("/history")({
	component: TranslateHistoryPage,
});

function TranslateHistoryPage() {
	const [isClient, setIsClient] = useState(false);

	useEffect(() => {
		setIsClient(true);
	}, []);

	if (!isClient) return null;

	return <TranslateHistoryPageClient />;
}

function formatDateTime(createdAt: number, uiLang: "zh" | "en") {
	return new Date(createdAt).toLocaleString(
		uiLang === "zh" ? "zh-CN" : "en-US",
	);
}

function createHistoryExportFileName() {
	const stamp = new Date()
		.toISOString()
		.replaceAll(":", "-")
		.replaceAll(".", "-");
	return `mintranslate-translate-history-${stamp}.json`;
}

function exportHistoryAsJson(
	items: TranslateHistoryItem[],
	t: (key: string, options?: Record<string, unknown>) => string,
) {
	try {
		const json = JSON.stringify(items, null, 2);
		const blob = new Blob([json], {
			type: "application/json;charset=utf-8",
		});
		const url = URL.createObjectURL(blob);
		const a = globalThis.document?.createElement?.("a");
		if (!a) throw new Error("Download unavailable");
		a.href = url;
		a.download = createHistoryExportFileName();
		globalThis.document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		toast.success(t("translateHistoryPage.toasts.exported"));
	} catch {
		toast.error(t("translateHistoryPage.toasts.exportFailed"));
	}
}

function TranslateHistoryPageClient() {
	const { t, i18n } = useTranslation();
	const uiLang = normalizeAppLanguage(i18n.resolvedLanguage) ?? "zh";
	const langLabel = useLangLabels();

	const { data, isLoading } = useLiveQuery(() => translateHistoryCollection);

	const [pageSize, setPageSize] = useState<10 | 100>(10);
	const [page, setPage] = useState(1);

	const sortedItems = useMemo(() => {
		return (data ?? []).slice().sort((a, b) => b.createdAt - a.createdAt);
	}, [data]);

	const total = sortedItems.length;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));

	useEffect(() => {
		if (page > pageCount) setPage(pageCount);
	}, [page, pageCount]);

	const startIndex = (page - 1) * pageSize;
	const endIndex = Math.min(startIndex + pageSize, total);
	const items = sortedItems.slice(startIndex, endIndex);

	return (
		<div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
			<div className="mx-auto container px-4 py-10 sm:px-6 lg:px-10">
				<header className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-2">
						<h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
							{t("translateHistoryPage.title")}
						</h1>
						<p className="text-sm text-muted-foreground">
							{t("translateHistoryPage.subtitle")}
						</p>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button type="button" variant="outline">
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

						<Button asChild type="button" variant="outline">
							<Link to="/">
								<HomeIcon />
								{t("translateHistoryPage.actions.backHome")}
							</Link>
						</Button>

						<ThemeToggle />
					</div>
				</header>

				<Separator className="my-8" />

				<Card className="gap-4 py-4">
					<CardHeader className="border-b py-0">
						<div className="space-y-1">
							<CardTitle className="text-base">
								{t("translateHistoryPage.card.title")}{" "}
								<span className="text-sm font-normal text-muted-foreground">
									({t("translateHistoryPage.card.total", { count: total })})
								</span>
							</CardTitle>
							<CardDescription>
								{t("translateHistoryPage.card.description")}
							</CardDescription>
						</div>

						<CardAction className="flex flex-wrap items-center gap-2">
							<Select
								value={String(pageSize)}
								onValueChange={(nextValue) => {
									const next =
										nextValue === "100" ? (100 as const) : (10 as const);
									setPageSize(next);
									setPage(1);
								}}
							>
								<SelectTrigger className="h-8 w-[120px]">
									<SelectValue
										placeholder={t("translateHistoryPage.actions.pageSize")}
									/>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="10">
										{t("translateHistoryPage.pageSize.items10")}
									</SelectItem>
									<SelectItem value="100">
										{t("translateHistoryPage.pageSize.items100")}
									</SelectItem>
								</SelectContent>
							</Select>

							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!total}
								onClick={() => exportHistoryAsJson(sortedItems, t)}
							>
								<DownloadIcon />
								{t("translateHistoryPage.actions.exportJson")}
							</Button>

							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={!total}
									>
										<Trash2Icon />
										{t("translateHistoryPage.actions.clear")}
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>
											{t("translateHistoryPage.confirm.title")}
										</AlertDialogTitle>
										<AlertDialogDescription>
											{t("translateHistoryPage.confirm.description")}
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>
											{t("common.actions.cancel")}
										</AlertDialogCancel>
										<AlertDialogAction
											className="bg-destructive text-white hover:bg-destructive/90"
											onClick={() => {
												const allIds = (data ?? []).map((item) => item.id);
												if (!allIds.length) return;
												translateHistoryCollection.delete(allIds);
												setPage(1);
												toast.success(t("translateHistoryPage.toasts.cleared"));
											}}
										>
											{t("common.actions.clear")}
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
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
								{t("translateHistoryPage.empty")}
							</p>
						) : null}

						{items.length ? (
							<>
								<div className="mb-4 mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
									<span>
										{t("translateHistoryPage.pagination.showing", {
											from: startIndex + 1,
											to: endIndex,
											total,
										})}
									</span>

									<div className="flex items-center gap-2">
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={page <= 1}
											onClick={() => setPage((p) => Math.max(1, p - 1))}
										>
											<ChevronLeftIcon />
											{t("translateHistoryPage.pagination.prev")}
										</Button>
										<span className="text-sm text-muted-foreground">
											{t("translateHistoryPage.pagination.page", {
												page,
												pageCount,
											})}
										</span>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={page >= pageCount}
											onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
										>
											{t("translateHistoryPage.pagination.next")}
											<ChevronRightIcon />
										</Button>
									</div>
								</div>

								<ScrollArea className="h-[640px] pr-4">
									<ul className="space-y-4">
										{items.map((item) => (
											<li
												key={item.id}
												className="bg-card rounded-lg border p-4"
											>
												<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
													<span>{formatDateTime(item.createdAt, uiLang)}</span>

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
																		onClick={() =>
																			copyToClipboard(item.sourceText, t)
																		}
																		aria-label={t(
																			"home.ui.tooltips.copySource",
																		)}
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
																		aria-label={t(
																			"home.ui.tooltips.copyTranslation",
																		)}
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
								</ScrollArea>
							</>
						) : null}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
