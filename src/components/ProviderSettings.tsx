import { type AnyFieldApi, useForm } from "@tanstack/react-form";
import { useStore } from "@tanstack/react-store";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function FieldInfo({ field }: { field: AnyFieldApi }) {
	const { t } = useTranslation();
	const errors = field.state.meta.errors
		.map((err) => (err.startsWith("errors.") ? t(err) : err))
		.join(", ");

	return (
		<>
			{field.state.meta.isTouched && !field.state.meta.isValid ? (
				<p className="mt-2 text-xs text-destructive">{errors}</p>
			) : null}
			{field.state.meta.isValidating ? (
				<p className="mt-2 text-xs text-muted-foreground">
					{t("common.status.validating")}
				</p>
			) : null}
		</>
	);
}

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

	const form = useForm({
		defaultValues: {
			id: editingProvider?.id ?? "",
			type: defaultType,
			name: defaultName,
			model: defaultModel,
			apiKey: defaultApiKey,
			baseUrl: defaultBaseUrl,
		},
		onSubmit: async ({ value }) => {
			setSubmitError("");

			const result = saveProviderFromForm({
				id: value.id || undefined,
				type: value.type,
				name: value.name,
				model: value.model,
				apiKey: value.apiKey,
				baseUrl: value.baseUrl,
			});

			if (result.error) {
				setSubmitError(result.error);
				return;
			}

			toast.success(t("home.providerDialog.form.toasts.saved"));
			onSaved(result.providerId ?? "");
		},
	});

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				e.stopPropagation();
				form.handleSubmit();
			}}
		>
			<form.Field name="type">
				{(field) => (
					<>
						<Label className="mt-4" htmlFor={field.name}>
							{t("home.providerDialog.form.fields.providerType.label")}
						</Label>
						<Select
							value={field.state.value}
							onValueChange={(nextType) => {
								const prevType = field.state.value;
								const nextProviderType = nextType as ProviderType;
								field.handleChange(nextProviderType);

								const prevDefaultName = normalizeProviderName(prevType);
								const nextDefaultName = normalizeProviderName(nextProviderType);

								const currentName = form.getFieldValue("name");
								const shouldAutoRename =
									!currentName.trim() || currentName.trim() === prevDefaultName;
								if (shouldAutoRename) {
									form.setFieldValue("name", nextDefaultName);
								}

								form.setFieldValue(
									"model",
									DEFAULT_MODEL_BY_PROVIDER[nextProviderType],
								);
								form.setFieldValue("apiKey", "");
								form.setFieldValue(
									"baseUrl",
									nextProviderType === "ollama" ? "http://localhost:11434" : "",
								);
							}}
						>
							<SelectTrigger id={field.name} className="mt-2 w-full">
								<SelectValue
									placeholder={t(
										"home.providerDialog.form.fields.providerType.placeholder",
									)}
								/>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="openai">OpenAI</SelectItem>
								<SelectItem value="anthropic">Anthropic</SelectItem>
								<SelectItem value="gemini">Google Gemini</SelectItem>
								<SelectItem value="ollama">Ollama</SelectItem>
							</SelectContent>
						</Select>
					</>
				)}
			</form.Field>

			<form.Field
				name="name"
				validators={{
					onChange: ({ value }) =>
						!value.trim() ? "errors.providerNameRequired" : undefined,
				}}
			>
				{(field) => (
					<>
						<Label className="mt-4" htmlFor={field.name}>
							{t("home.providerDialog.form.fields.name.label")}
						</Label>
						<Input
							id={field.name}
							type="text"
							inputMode="text"
							autoComplete="off"
							spellCheck={false}
							className="mt-2"
							placeholder={t(
								"home.providerDialog.form.fields.name.placeholder",
							)}
							value={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
						/>
						<FieldInfo field={field} />
					</>
				)}
			</form.Field>

			<form.Field
				name="model"
				validators={{
					onChange: ({ value }) =>
						!value.trim() ? "errors.modelRequired" : undefined,
				}}
			>
				{(field) => (
					<>
						<Label className="mt-4" htmlFor={field.name}>
							{t("home.providerDialog.form.fields.model.label")}
						</Label>
						<Input
							id={field.name}
							type="text"
							inputMode="text"
							autoComplete="off"
							spellCheck={false}
							className="mt-2"
							placeholder={t(
								"home.providerDialog.form.fields.model.placeholder",
							)}
							value={field.state.value}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
						/>
						<FieldInfo field={field} />
					</>
				)}
			</form.Field>

			<form.Subscribe selector={(state) => state.values.type}>
				{(providerType) => (
					<>
						{providerType === "openai" ? (
							<form.Field name="baseUrl">
								{(field) => (
									<>
										<Label className="mt-4" htmlFor={field.name}>
											{t("home.providerDialog.form.fields.baseUrl.label")}
										</Label>
										<Input
											id={field.name}
											type="text"
											inputMode="url"
											autoComplete="off"
											spellCheck={false}
											className="mt-2"
											placeholder={t(
												"home.providerDialog.form.fields.baseUrl.placeholder",
											)}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
										/>
										<FieldInfo field={field} />
									</>
								)}
							</form.Field>
						) : null}

						{providerType === "ollama" ? (
							<form.Field name="baseUrl">
								{(field) => (
									<>
										<Label className="mt-4" htmlFor={field.name}>
											{t("home.providerDialog.form.fields.ollamaHost.label")}
										</Label>
										<Input
											id={field.name}
											type="text"
											inputMode="url"
											autoComplete="off"
											spellCheck={false}
											className="mt-2"
											placeholder={t(
												"home.providerDialog.form.fields.ollamaHost.placeholder",
											)}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
										/>
										<FieldInfo field={field} />
									</>
								)}
							</form.Field>
						) : null}

						{providerType !== "ollama" ? (
							<form.Field
								name="apiKey"
								validators={{
									onChange: ({ value }) =>
										!value.trim() ? "errors.apiKeyRequired" : undefined,
								}}
							>
								{(field) => (
									<>
										<Label className="mt-4" htmlFor={field.name}>
											{t("home.providerDialog.form.fields.apiKey.label")}
										</Label>
										<Input
											id={field.name}
											type="password"
											inputMode="text"
											autoComplete="off"
											spellCheck={false}
											className="mt-2"
											placeholder={t(
												"home.providerDialog.form.fields.apiKey.placeholder",
											)}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
										/>
										<FieldInfo field={field} />
									</>
								)}
							</form.Field>
						) : null}
					</>
				)}
			</form.Subscribe>

			{submitError ? (
				<Alert className="mt-4" variant="destructive">
					<TriangleAlertIcon />
					<AlertTitle>
						{t("home.providerDialog.form.submitErrorTitle")}
					</AlertTitle>
					<AlertDescription>
						{submitError.startsWith("errors.") ? t(submitError) : submitError}
					</AlertDescription>
				</Alert>
			) : null}

			<div className="mt-6 flex justify-end gap-3">
				<form.Subscribe
					selector={(state) => [state.canSubmit, state.isSubmitting] as const}
				>
					{([canSubmit, isSubmitting]) => (
						<Button type="submit" disabled={!canSubmit} className="min-w-24">
							{isSubmitting ? (
								<>
									<Spinner />
									{t("common.actions.saving")}
								</>
							) : (
								t("common.actions.save")
							)}
						</Button>
					)}
				</form.Subscribe>
			</div>
		</form>
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
