import { createFileRoute, Link } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { HomeIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ProviderSettings } from "@/components/ProviderSettings";
import { ThemeToggle } from "@/components/ThemeToggle";
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
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { normalizeAppLanguage, setAppLanguage } from "@/lib/app-i18n";
import {
	DEFAULT_SYSTEM_PROMPT,
	saveSystemPrompt,
	translateStore,
} from "@/stores/translateStore";

export const Route = createFileRoute("/settings")({
	component: SettingsPage,
});

function SettingsPage() {
	const { t, i18n } = useTranslation();
	const uiLang = normalizeAppLanguage(i18n.resolvedLanguage) ?? "zh";

	const systemPromptTextareaId = useId();

	const savedSystemPrompt = useStore(
		translateStore,
		(state) => state.systemPrompt,
	);
	const [draftSystemPrompt, setDraftSystemPrompt] = useState(savedSystemPrompt);
	const [isSavingSystemPrompt, setIsSavingSystemPrompt] = useState(false);
	const prevSavedSystemPromptRef = useRef(savedSystemPrompt);

	const isSystemPromptDirty = useMemo(() => {
		return draftSystemPrompt !== savedSystemPrompt;
	}, [draftSystemPrompt, savedSystemPrompt]);

	useEffect(() => {
		setDraftSystemPrompt((currentDraft) => {
			const prevSaved = prevSavedSystemPromptRef.current;
			prevSavedSystemPromptRef.current = savedSystemPrompt;

			if (currentDraft !== prevSaved) return currentDraft;
			return savedSystemPrompt;
		});
	}, [savedSystemPrompt]);

	return (
		<div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
			<div className="mx-auto container px-4 py-10 sm:px-6 lg:px-10">
				<header className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-2">
						<h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
							{t("settingsPage.title")}
						</h1>
						<p className="text-sm text-muted-foreground">
							{t("settingsPage.subtitle")}
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
								{t("settingsPage.actions.backHome")}
							</Link>
						</Button>

						<ThemeToggle />
					</div>
				</header>

				<Separator className="my-8" />

				<div className="space-y-6">
					<Card className="gap-4 py-4">
						<CardHeader className="border-b py-0">
							<div className="space-y-1">
								<CardTitle className="text-base">
									{t("settingsPage.systemPrompt.title")}
								</CardTitle>
								<CardDescription>
									{t("settingsPage.systemPrompt.description")}
								</CardDescription>
							</div>

							<CardAction className="flex flex-wrap items-center gap-2">
								<Button
									type="button"
									variant="outline"
									disabled={isSavingSystemPrompt}
									onClick={() => setDraftSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
								>
									{t("settingsPage.systemPrompt.actions.reset")}
								</Button>
								<Button
									type="button"
									disabled={!isSystemPromptDirty || isSavingSystemPrompt}
									onClick={() => {
										setIsSavingSystemPrompt(true);
										void saveSystemPrompt(draftSystemPrompt)
											.then(() => {
												toast.success(
													t("settingsPage.systemPrompt.toasts.saved"),
												);
											})
											.catch(() => {
												toast.error(
													t("settingsPage.systemPrompt.toasts.saveFailed"),
												);
											})
											.finally(() => {
												setIsSavingSystemPrompt(false);
											});
									}}
								>
									{isSavingSystemPrompt ? (
										<>
											<Spinner />
											{t("common.actions.saving")}
										</>
									) : (
										t("common.actions.save")
									)}
								</Button>
							</CardAction>
						</CardHeader>

						<CardContent className="pt-0">
							<Label htmlFor={systemPromptTextareaId}>
								{t("settingsPage.systemPrompt.fields.systemPrompt.label")}
							</Label>
							<Textarea
								id={systemPromptTextareaId}
								className="mt-2 min-h-48"
								placeholder={t(
									"settingsPage.systemPrompt.fields.systemPrompt.placeholder",
								)}
								value={draftSystemPrompt}
								onChange={(e) => setDraftSystemPrompt(e.target.value)}
							/>

							<p className="mt-2 text-xs text-muted-foreground">
								{t("common.units.characters", {
									count: draftSystemPrompt.length,
								})}
							</p>
						</CardContent>
					</Card>

					<Card className="gap-4 py-4">
						<CardHeader className="border-b py-0">
							<div className="space-y-1">
								<CardTitle className="text-base">
									{t("settingsPage.providers.title")}
								</CardTitle>
								<CardDescription>
									{t("settingsPage.providers.description")}
								</CardDescription>
							</div>
						</CardHeader>

						<CardContent className="pt-0">
							<ProviderSettings />
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
