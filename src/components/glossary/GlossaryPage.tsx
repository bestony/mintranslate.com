/** Browser-local glossary management. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	addTerm,
	deleteTerm,
	type ExportFormat,
	exportTerms,
	type GlossaryTerm,
	type GlossaryTermInput,
	type ImportConflictStrategy,
	importTerms,
	listTerms,
	serializeGlossary,
	updateTerm,
} from "#/lib/glossary";
import { AUTO_DETECT, LANGUAGE_CODES, languageName } from "#/lib/languages";
import { logger } from "#/lib/logger";
import { VirtualList } from "../history/VirtualList";

const GLOSSARY_ROW_HEIGHT = 160;
const LANGUAGE_OPTIONS = [AUTO_DETECT, ...LANGUAGE_CODES] as const;

interface GlossaryFormState extends GlossaryTermInput {}

const EMPTY_FORM: GlossaryFormState = {
	source: "",
	target: "",
	sl: "auto",
	tl: "zh-Hans",
	caseSensitive: false,
	note: "",
	priority: 0,
};

function downloadText(content: string, fileName: string, type: string): void {
	if (typeof URL === "undefined" || typeof Blob === "undefined") return;
	const url = URL.createObjectURL(new Blob([content], { type }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(url);
}

function pairLabel(term: Pick<GlossaryTerm, "sl" | "tl">): string {
	return `${languageName(term.sl)} → ${languageName(term.tl)}`;
}

function matchesKeyword(term: GlossaryTerm, keyword: string): boolean {
	if (keyword === "") return true;
	return [term.source, term.target, term.note].some((value) =>
		value.toLocaleLowerCase().includes(keyword),
	);
}

export function GlossaryPage() {
	const [terms, setTerms] = useState<readonly GlossaryTerm[]>([]);
	const [loading, setLoading] = useState(true);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [sourceFilter, setSourceFilter] = useState("");
	const [targetFilter, setTargetFilter] = useState("");
	const [keyword, setKeyword] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [editingId, setEditingId] = useState<string | undefined>(undefined);
	const [form, setForm] = useState<GlossaryFormState>(EMPTY_FORM);
	const [confirming, setConfirming] = useState<string | "batch" | undefined>(
		undefined,
	);
	const [pendingImport, setPendingImport] = useState<
		{ readonly text: string; readonly format: ExportFormat } | undefined
	>(undefined);
	const fileRef = useRef<HTMLInputElement>(null);
	const loadGeneration = useRef(0);

	const reload = useCallback(async () => {
		const generation = loadGeneration.current + 1;
		loadGeneration.current = generation;
		setLoading(true);
		const result = await listTerms();
		if (generation !== loadGeneration.current) return;
		setLoading(false);
		if (!result.ok) {
			logger.warn("glossary.ui.load-failed", { reason: result.reason });
			setFailure("术语表暂时不可用。请检查浏览器的本地存储权限。");
			return;
		}
		setFailure(undefined);
		setTerms(result.value);
		const existingIds = new Set(result.value.map((term) => term.id));
		setSelected((current) => {
			const next = new Set<string>();
			for (const id of current) {
				if (existingIds.has(id)) next.add(id);
			}
			return next;
		});
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const shown = useMemo(() => {
		const normalizedKeyword = keyword.trim().toLocaleLowerCase();
		return terms
			.filter(
				(term) =>
					(sourceFilter === "" || term.sl === sourceFilter) &&
					(targetFilter === "" || term.tl === targetFilter) &&
					matchesKeyword(term, normalizedKeyword),
			)
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}, [keyword, sourceFilter, targetFilter, terms]);

	function beginAdd() {
		setEditingId("");
		setForm({
			...EMPTY_FORM,
			sl: sourceFilter || AUTO_DETECT,
			tl: targetFilter || EMPTY_FORM.tl,
		});
		setNotice(undefined);
	}

	function beginEdit(term: GlossaryTerm) {
		setEditingId(term.id);
		setForm({
			source: term.source,
			target: term.target,
			sl: term.sl,
			tl: term.tl,
			caseSensitive: term.caseSensitive,
			note: term.note,
			priority: term.priority,
		});
		setNotice(undefined);
	}

	async function saveForm(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const result =
			editingId === ""
				? await addTerm(form)
				: await updateTerm(editingId ?? "", form);
		if (!result.ok) {
			setNotice(result.reason);
			return;
		}
		setEditingId(undefined);
		setNotice(editingId === "" ? "术语已添加。" : "术语已更新。");
		await reload();
	}

	async function removeOne(id: string) {
		if (confirming !== id) {
			setConfirming(id);
			return;
		}
		const result = await deleteTerm(id);
		setConfirming(undefined);
		if (!result.ok) setNotice(result.reason);
		else {
			setNotice(result.value ? "术语已删除。" : "术语已经不存在。");
			await reload();
		}
	}

	async function removeSelected() {
		if (selected.size === 0) return;
		if (confirming !== "batch") {
			setConfirming("batch");
			return;
		}
		const ids = [...selected];
		let removed = 0;
		for (const id of ids) {
			const result = await deleteTerm(id);
			if (result.ok && result.value) removed += 1;
		}
		setConfirming(undefined);
		setSelected(new Set());
		setNotice(`已删除 ${removed} 条术语。`);
		await reload();
	}

	async function exportFiltered(format: ExportFormat) {
		// Keep the store call as the availability check, then serialize the visible
		// filter so a keyword search can be exported without leaking other terms.
		const available = await exportTerms(format, {
			sl: sourceFilter || AUTO_DETECT,
			tl: targetFilter || EMPTY_FORM.tl,
		});
		if (!available.ok && available.reason !== undefined) {
			setNotice(available.reason);
			return;
		}
		const content = serializeGlossary(shown, format);
		downloadText(
			content,
			`mintranslate-glossary.${format}`,
			format === "json" ? "application/json" : "text/csv",
		);
		setNotice(`已导出 ${shown.length} 条术语。`);
	}

	async function handleFile(file: File) {
		try {
			const text = await file.text();
			const format: ExportFormat = file.name
				.toLocaleLowerCase()
				.endsWith(".csv")
				? "csv"
				: "json";
			setPendingImport({ text, format });
			setNotice("请选择冲突处理方式后导入。");
		} catch {
			setNotice("无法读取导入文件。");
		}
	}

	async function applyImport(conflict: ImportConflictStrategy) {
		if (!pendingImport) return;
		const result = await importTerms(pendingImport.text, {
			format: pendingImport.format,
			conflict,
		});
		setPendingImport(undefined);
		if (!result.ok) {
			setNotice(result.reason);
			return;
		}
		setNotice(
			`导入完成：新增 ${result.value.inserted}，更新 ${result.value.updated}，跳过 ${result.value.skipped}，无效 ${result.value.invalid}。`,
		);
		await reload();
	}

	return (
		<main className="page-wrap py-6 md:py-10">
			<header>
				<h1 className="display-title font-bold text-2xl md:text-3xl">术语表</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
					管理浏览器本地的术语规则。术语会在翻译请求中强制使用。
				</p>
			</header>

			<div className="mt-6 flex flex-wrap items-end gap-4">
				<label className="block min-w-40 text-sm">
					<span>源语言</span>
					<select
						id="glossary-source-filter"
						name="glossary-source-filter"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={sourceFilter}
						onChange={(event) => setSourceFilter(event.target.value)}
					>
						<option value="">全部源语言</option>
						{LANGUAGE_OPTIONS.map((code) => (
							<option key={code} value={code}>
								{languageName(code)}
							</option>
						))}
					</select>
				</label>
				<label className="block min-w-40 text-sm">
					<span>目标语言</span>
					<select
						id="glossary-target-filter"
						name="glossary-target-filter"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={targetFilter}
						onChange={(event) => setTargetFilter(event.target.value)}
					>
						<option value="">全部目标语言</option>
						{LANGUAGE_OPTIONS.filter((code) => code !== AUTO_DETECT).map(
							(code) => (
								<option key={code} value={code}>
									{languageName(code)}
								</option>
							),
						)}
					</select>
				</label>
				<label className="block min-w-56 flex-1 text-sm">
					<span>关键字</span>
					<input
						id="glossary-keyword"
						name="glossary-keyword"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						placeholder="搜索源词、译词或备注"
						value={keyword}
						onChange={(event) => setKeyword(event.target.value)}
					/>
				</label>
			</div>

			<div className="mt-4 flex flex-wrap gap-2 text-sm">
				<button
					type="button"
					className="min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground"
					onClick={beginAdd}
				>
					新增术语
				</button>
				<button
					type="button"
					className="min-h-11 rounded-sm border border-border px-4 disabled:opacity-40"
					disabled={selected.size === 0}
					onClick={() => void removeSelected()}
				>
					{confirming === "batch"
						? "确认批量删除"
						: `批量删除（${selected.size}）`}
				</button>
				<button
					type="button"
					className="min-h-11 rounded-sm border border-border px-4"
					onClick={() => void exportFiltered("csv")}
				>
					导出 CSV
				</button>
				<button
					type="button"
					className="min-h-11 rounded-sm border border-border px-4"
					onClick={() => void exportFiltered("json")}
				>
					导出 JSON
				</button>
				<button
					type="button"
					className="min-h-11 rounded-sm border border-border px-4"
					onClick={() => fileRef.current?.click()}
				>
					导入
				</button>
				<input
					ref={fileRef}
					id="glossary-import-file"
					name="glossary-import-file"
					type="file"
					accept=".csv,.json,text/csv,application/json"
					className="hidden"
					aria-label="导入术语文件"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void handleFile(file);
						event.target.value = "";
					}}
				/>
			</div>

			{pendingImport && (
				<div className="mt-4 rounded-sm border border-border bg-surface p-4 text-sm">
					<p>导入文件遇到同一语言对中的相同源词时：</p>
					<div className="mt-2 flex flex-wrap gap-2">
						<button
							type="button"
							className="min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground"
							onClick={() => void applyImport("skip")}
						>
							跳过冲突
						</button>
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-4"
							onClick={() => void applyImport("overwrite")}
						>
							覆盖冲突
						</button>
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-4"
							onClick={() => setPendingImport(undefined)}
						>
							取消
						</button>
					</div>
				</div>
			)}

			{editingId !== undefined && (
				<form
					className="mt-4 rounded-sm border border-border bg-surface p-4"
					onSubmit={(event) => void saveForm(event)}
				>
					<h2 className="font-semibold text-lg">
						{editingId === "" ? "新增术语" : "编辑术语"}
					</h2>
					<div className="mt-4 grid gap-4 md:grid-cols-2">
						<label className="text-sm">
							<span>源词</span>
							<input
								id="glossary-form-source"
								name="source"
								required
								className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
								value={form.source}
								onChange={(event) =>
									setForm({ ...form, source: event.target.value })
								}
							/>
						</label>
						<label className="text-sm">
							<span>译词</span>
							<input
								id="glossary-form-target"
								name="target"
								required
								className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
								value={form.target}
								onChange={(event) =>
									setForm({ ...form, target: event.target.value })
								}
							/>
						</label>
						<label className="text-sm">
							<span>源语言</span>
							<select
								id="glossary-form-sl"
								name="sl"
								className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
								value={form.sl}
								onChange={(event) =>
									setForm({ ...form, sl: event.target.value })
								}
							>
								{LANGUAGE_OPTIONS.map((code) => (
									<option key={code} value={code}>
										{languageName(code)}
									</option>
								))}
							</select>
						</label>
						<label className="text-sm">
							<span>目标语言</span>
							<select
								id="glossary-form-tl"
								name="tl"
								className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
								value={form.tl}
								onChange={(event) =>
									setForm({ ...form, tl: event.target.value })
								}
							>
								{LANGUAGE_OPTIONS.filter((code) => code !== AUTO_DETECT).map(
									(code) => (
										<option key={code} value={code}>
											{languageName(code)}
										</option>
									),
								)}
							</select>
						</label>
						<label className="text-sm">
							<span>优先级</span>
							<input
								type="number"
								id="glossary-form-priority"
								name="priority"
								className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
								value={form.priority ?? 0}
								onChange={(event) =>
									setForm({ ...form, priority: Number(event.target.value) })
								}
							/>
						</label>
						<label className="flex min-h-11 items-center gap-2 text-sm">
							<input
								type="checkbox"
								id="glossary-form-case-sensitive"
								name="case-sensitive"
								checked={form.caseSensitive ?? false}
								onChange={(event) =>
									setForm({ ...form, caseSensitive: event.target.checked })
								}
							/>
							区分大小写
						</label>
						<label className="text-sm md:col-span-2">
							<span>备注</span>
							<textarea
								id="glossary-form-note"
								name="note"
								className="mt-2 min-h-24 w-full rounded-sm border border-input bg-background px-4 py-2"
								value={form.note ?? ""}
								onChange={(event) =>
									setForm({ ...form, note: event.target.value })
								}
							/>
						</label>
					</div>
					<div className="mt-4 flex flex-wrap gap-2">
						<button
							type="submit"
							className="min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground"
						>
							保存
						</button>
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-4"
							onClick={() => setEditingId(undefined)}
						>
							取消
						</button>
					</div>
				</form>
			)}

			{failure && (
				<p className="mt-4 rounded-sm border border-border bg-surface p-4 text-sm">
					{failure}
				</p>
			)}
			{notice && <p className="mt-4 text-muted-foreground text-sm">{notice}</p>}
			<p className="mt-4 text-muted-foreground text-sm">
				{loading ? "读取中…" : `显示 ${shown.length} / ${terms.length} 条术语`}
			</p>

			<VirtualList
				className="mt-4 h-[60vh] min-h-60 overflow-y-auto rounded-sm border border-border"
				items={shown}
				rowHeight={GLOSSARY_ROW_HEIGHT}
				emptyState={
					<p className="p-6 text-muted-foreground text-sm">
						{loading ? "读取中…" : "没有匹配的术语。"}
					</p>
				}
				renderItem={(term) => (
					<div className="flex h-full items-start gap-4 border-border border-b p-4">
						<input
							type="checkbox"
							id={`glossary-select-${term.id}`}
							name="glossary-select"
							className="mt-2"
							aria-label={`选择术语 ${term.source}`}
							checked={selected.has(term.id)}
							onChange={(event) => {
								setSelected((current) => {
									const next = new Set(current);
									if (event.target.checked) next.add(term.id);
									else next.delete(term.id);
									return next;
								});
							}}
						/>
						<div className="min-w-0 flex-1 text-sm">
							<p className="break-words font-medium">
								{term.source} → {term.target}
							</p>
							<p className="mt-2 text-muted-foreground text-xs">
								{pairLabel(term)} · 优先级 {term.priority}
								{term.caseSensitive ? " · 区分大小写" : ""}
							</p>
							{term.note && (
								<p className="mt-2 break-words text-muted-foreground text-xs">
									{term.note}
								</p>
							)}
						</div>
						<div className="flex shrink-0 flex-wrap gap-2 text-xs">
							<button
								type="button"
								className="min-h-11 rounded-sm border border-border px-4"
								onClick={() => beginEdit(term)}
							>
								编辑
							</button>
							<button
								type="button"
								className="min-h-11 rounded-sm border border-border px-4"
								onClick={() => void removeOne(term.id)}
							>
								{confirming === term.id ? "确认删除" : "删除"}
							</button>
						</div>
					</div>
				)}
			/>
		</main>
	);
}
