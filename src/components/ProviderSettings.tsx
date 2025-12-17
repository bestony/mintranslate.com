import { zodResolver } from "@hookform/resolvers/zod";
import { useStore } from "@tanstack/react-store";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	type AIProvider,
	DEFAULT_MODEL_BY_PROVIDER,
	deleteProvider,
	type ProviderType,
	saveProviderFromForm,
	setDefaultProvider,
	translateStore,
} from "@/stores/translateStore";

function normalizeProviderName(providerType: ProviderType) {
	switch (providerType) {
		case "openai":
			return "OpenAI";
		case "anthropic":
			return "Anthropic";
		case "gemini":
			return "Gemini";
		case "ollama":
			return "Ollama";
	}
}

// Zod schema for form validation
const formSchema = z
	.object({
		id: z.string(),
		type: z.enum(["openai", "anthropic", "gemini", "ollama"]),
		name: z.string().min(1, "errors.providerNameRequired"),
		model: z.string().min(1, "errors.modelRequired"),
		apiKey: z.string(),
		baseUrl: z.string(),
	})
	.refine(
		(data) => {
			// API key is not required for Ollama
			if (data.type === "ollama") return true;
			return data.apiKey.trim() !== "";
		},
		{
			message: "errors.apiKeyRequired",
			path: ["apiKey"],
		},
	);

type FormValues = z.infer<typeof formSchema>;

function ProviderEditorForm({
	editingProvider,
	initialType,
	onSaved,
}: {
	editingProvider: AIProvider | null;
	initialType: ProviderType;
	onSaved: (providerId: string) => void;
}) {
	const { t } = useTranslation();
	const [submitError, setSubmitError] = useState("");

	const defaultType = editingProvider?.type ?? initialType;
	const defaultName =
		editingProvider?.name ?? normalizeProviderName(defaultType);
	const defaultModel =
		editingProvider?.model ?? DEFAULT_MODEL_BY_PROVIDER[defaultType];
	const defaultApiKey = editingProvider?.apiKey ?? "";
	const defaultBaseUrl =
		editingProvider?.baseUrl ??
		(defaultType === "ollama" ? "http://localhost:11434" : "");

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			id: editingProvider?.id ?? "",
			type: defaultType,
			name: defaultName,
			model: defaultModel,
			apiKey: defaultApiKey,
			baseUrl: defaultBaseUrl,
		},
	});

	const providerType = form.watch("type");

	function onSubmit(values: FormValues) {
		setSubmitError("");

		const result = saveProviderFromForm({
			id: values.id || undefined,
			type: values.type,
			name: values.name,
			model: values.model,
			apiKey: values.apiKey,
			baseUrl: values.baseUrl,
		});

		if (result.error) {
			setSubmitError(result.error);
			return;
		}

		toast.success(t("home.providerDialog.form.toasts.saved"));
		onSaved(result.providerId ?? "");
	}

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
				<FormField
					control={form.control}
					name="type"
					render={({ field }) => (
						<FormItem>
							<FormLabel>
								{t("home.providerDialog.form.fields.providerType.label")}
							</FormLabel>
							<Select
								onValueChange={(nextType: ProviderType) => {
									const prevType = field.value;
									field.onChange(nextType);

									const prevDefaultName = normalizeProviderName(prevType);
									const nextDefaultName = normalizeProviderName(nextType);
									const currentName = form.getValues("name");
									if (!currentName.trim() || currentName.trim() === prevDefaultName) {
										form.setValue("name", nextDefaultName);
									}

									form.setValue("model", DEFAULT_MODEL_BY_PROVIDER[nextType]);
									form.setValue("apiKey", "");
									form.setValue(
										"baseUrl",
										nextType === "ollama" ? "http://localhost:11434" : "",
									);
								}}
								value={field.value}
							>
								<FormControl>
									<SelectTrigger>
										<SelectValue
											placeholder={t(
												"home.providerDialog.form.fields.providerType.placeholder",
											)}
										/>
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									<SelectItem value="openai">OpenAI</SelectItem>
									<SelectItem value="anthropic">Anthropic</SelectItem>
									<SelectItem value="gemini">Google Gemini</SelectItem>
									<SelectItem value="ollama">Ollama</SelectItem>
								</SelectContent>
							</Select>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							<FormLabel>
								{t("home.providerDialog.form.fields.name.label")}
							</FormLabel>
							<FormControl>
								<Input
									placeholder={t(
										"home.providerDialog.form.fields.name.placeholder",
									)}
									{...field}
								/>
							</FormControl>
							<FormMessage>
								{form.formState.errors.name?.message &&
									t(form.formState.errors.name.message)}
							</FormMessage>
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="model"
					render={({ field }) => (
						<FormItem>
							<FormLabel>
								{t("home.providerDialog.form.fields.model.label")}
							</FormLabel>
							<FormControl>
								<Input
									placeholder={t(
										"home.providerDialog.form.fields.model.placeholder",
									)}
									{...field}
								/>
							</FormControl>
							<FormMessage>
								{form.formState.errors.model?.message &&
									t(form.formState.errors.model.message)}
							</FormMessage>
						</FormItem>
					)}
				/>

				{providerType === "openai" && (
					<FormField
						control={form.control}
						name="baseUrl"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									{t("home.providerDialog.form.fields.baseUrl.label")}
								</FormLabel>
								<FormControl>
									<Input
										placeholder={t(
											"home.providerDialog.form.fields.baseUrl.placeholder",
										)}
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				)}

				{providerType === "ollama" && (
					<FormField
						control={form.control}
						name="baseUrl"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									{t("home.providerDialog.form.fields.ollamaHost.label")}
								</FormLabel>
								<FormControl>
									<Input
										placeholder={t(
											"home.providerDialog.form.fields.ollamaHost.placeholder",
										)}
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				)}

				{providerType !== "ollama" && (
					<FormField
						control={form.control}
						name="apiKey"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									{t("home.providerDialog.form.fields.apiKey.label")}
								</FormLabel>
								<FormControl>
									<Input type="password" {...field} />
								</FormControl>
								<FormMessage>
									{form.formState.errors.apiKey?.message &&
										t(form.formState.errors.apiKey.message)}
								</FormMessage>
							</FormItem>
						)}
					/>
				)}

				{submitError && (
					<Alert variant="destructive">
						<TriangleAlertIcon />
						<AlertTitle>
							{t("home.providerDialog.form.submitErrorTitle")}
						</AlertTitle>
						<AlertDescription>
							{submitError.startsWith("errors.") ? t(submitError) : submitError}
						</AlertDescription>
					</Alert>
				)}

				<div className="mt-6 flex justify-end gap-3">
					<Button
						type="submit"
						disabled={form.formState.isSubmitting}
						className="min-w-24"
					>
						{form.formState.isSubmitting ? (
							<>
								<Spinner />
								{t("common.actions.saving")}
							</>
						) : (
							t("common.actions.save")
						)}
					</Button>
				</div>
			</form>
		</Form>
	);
}

export function ProviderSettings() {
	const { t } = useTranslation();

	const providers = useStore(translateStore, (state) => state.providers);
	const defaultProviderId = useStore(
		translateStore,
		(state) => state.defaultProviderId,
	);

	const [editingProviderId, setEditingProviderId] = useState("");
	const [initialType, setInitialType] = useState<ProviderType>("gemini");
	const [hasChosenEditor, setHasChosenEditor] = useState(false);

	const editingProvider = useMemo(() => {
		if (!editingProviderId) return null;
		return providers.find((p) => p.id === editingProviderId) ?? null;
	}, [providers, editingProviderId]);

	useEffect(() => {
		const editingExists = editingProviderId
			? providers.some((p) => p.id === editingProviderId)
			: true;

		if (hasChosenEditor && editingProviderId && !editingExists) {
			const nextId =
				(defaultProviderId &&
					providers.some((p) => p.id === defaultProviderId) &&
					defaultProviderId) ||
				providers[0]?.id ||
				"";
			if (nextId !== editingProviderId) setEditingProviderId(nextId);
			return;
		}

		if (hasChosenEditor) return;

		const nextId =
			(defaultProviderId &&
				providers.some((p) => p.id === defaultProviderId) &&
				defaultProviderId) ||
			providers[0]?.id ||
			"";

		if (nextId !== editingProviderId) setEditingProviderId(nextId);
	}, [providers, defaultProviderId, editingProviderId, hasChosenEditor]);

	return (
		<div className="grid gap-6 sm:grid-cols-2">
			<section className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h3 className="text-sm font-semibold">
						{t("home.providerDialog.configured.title")}
					</h3>

					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="outline" size="sm">
								<PlusIcon />
								{t("common.actions.add")}
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								onSelect={() => {
									setHasChosenEditor(true);
									setEditingProviderId("");
									setInitialType("openai");
								}}
							>
								OpenAI
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => {
									setHasChosenEditor(true);
									setEditingProviderId("");
									setInitialType("anthropic");
								}}
							>
								Anthropic
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => {
									setHasChosenEditor(true);
									setEditingProviderId("");
									setInitialType("gemini");
								}}
							>
								Google Gemini
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() => {
									setHasChosenEditor(true);
									setEditingProviderId("");
									setInitialType("ollama");
								}}
							>
								Ollama
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				{providers.length ? (
					<ScrollArea className="h-[340px] pr-4">
						<ul className="space-y-2">
							{providers.map((p) => {
								const isDefault = p.id === defaultProviderId;
								return (
									<li
										key={p.id}
										className="bg-card flex flex-col gap-3 rounded-lg border p-3"
									>
										<div className="flex flex-wrap items-start justify-between gap-3">
											<div className="min-w-0 space-y-1">
												<p className="truncate text-sm font-medium">{p.name}</p>
												<div className="flex flex-wrap items-center gap-2">
													{isDefault ? (
														<Badge variant="secondary">
															{t("common.status.default")}
														</Badge>
													) : null}
													<Badge variant="outline">{p.type}</Badge>
													<Badge variant="outline">{p.model}</Badge>
												</div>
											</div>

											<div className="flex flex-wrap items-center gap-2">
												{!isDefault ? (
													<Button
														type="button"
														variant="secondary"
														size="sm"
														onClick={() => {
															setDefaultProvider(p.id);
															toast.success(
																t("home.providerDialog.toasts.setDefault", {
																	name: p.name,
																}),
															);
														}}
													>
														{t("common.actions.setDefault")}
													</Button>
												) : null}

												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() => {
														setHasChosenEditor(true);
														setEditingProviderId(p.id);
														setInitialType(p.type);
													}}
												>
													{t("common.actions.edit")}
												</Button>

												<AlertDialog>
													<AlertDialogTrigger asChild>
														<Button
															type="button"
															variant="destructive"
															size="sm"
														>
															{t("common.actions.delete")}
														</Button>
													</AlertDialogTrigger>
													<AlertDialogContent>
														<AlertDialogHeader>
															<AlertDialogTitle>
																{t("home.providerDialog.confirmDelete.title")}
															</AlertDialogTitle>
															<AlertDialogDescription>
																{t(
																	"home.providerDialog.confirmDelete.description",
																	{
																		name: p.name,
																	},
																)}
															</AlertDialogDescription>
														</AlertDialogHeader>
														<AlertDialogFooter>
															<AlertDialogCancel>
																{t("common.actions.cancel")}
															</AlertDialogCancel>
															<AlertDialogAction
																className="bg-destructive text-white hover:bg-destructive/90"
																onClick={() => {
																	deleteProvider(p.id);
																	if (editingProviderId === p.id) {
																		setHasChosenEditor(false);
																		setEditingProviderId("");
																	}
																	toast.success(
																		t("home.providerDialog.toasts.deleted", {
																			name: p.name,
																		}),
																	);
																}}
															>
																{t("common.actions.delete")}
															</AlertDialogAction>
														</AlertDialogFooter>
													</AlertDialogContent>
												</AlertDialog>
											</div>
										</div>
									</li>
								);
							})}
						</ul>
					</ScrollArea>
				) : (
					<p className="text-sm text-muted-foreground">
						{t("home.providerDialog.configured.empty")}
					</p>
				)}
			</section>

			<section className="space-y-3">
				<h3 className="text-sm font-semibold">
					{editingProviderId
						? t("home.providerDialog.form.titleEdit")
						: t("home.providerDialog.form.titleNew")}
				</h3>

				<ProviderEditorForm
					key={`${editingProviderId || "new"}-${initialType}`}
					editingProvider={editingProvider}
					initialType={initialType}
					onSaved={(providerId) => {
						if (providerId) {
							setHasChosenEditor(true);
							setEditingProviderId(providerId);
						}
					}}
				/>
			</section>
		</div>
	);
}
