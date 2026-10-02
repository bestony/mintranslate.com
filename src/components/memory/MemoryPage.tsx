/** Browser-local translation-memory management. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGE_CODES, languageName } from "#/lib/languages";
import { logger } from "#/lib/logger";
import {
	deleteMemories,
	deleteMemory,
	exportMemoryJson,
	exportMemoryTmx,
	importMemoryJson,
	importMemoryTmx,
	type MemoryFilter,
	type MemoryImportResult,
	type MemorySort,
	type MemorySortDirection,
	type MemoryStats,
	type MemoryStore,
	openMemoryStore,
	queryMemory,
	type TranslationMemoryRecord,
	updateMemory,
} from "#/lib/translation-memory";
import { VirtualList } from "../history/VirtualList";

const PAGE_SIZE = 30;
const MEMORY_ROW_HEIGHT = 184;
const ORIGINS = ["model", "user-edit", "import"] as const;

type MemoryOriginFilter = (typeof ORIGINS)[number] | "";

const ORIGIN_LABEL: Record<MemoryOriginFilter, string> = {
	"": "全部来源",
	model: "模型",
	"user-edit": "用户编辑",
	import: "导入",
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

function dateBoundary(value: string, endOfDay = false): number | undefined {
	if (value === "") return undefined;
	const parsed = Date.parse(
		`${value}${endOfDay ? "T23:59:59.999" : "T00:00:00"}`,
	);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function pairLabel(record: Pick<TranslationMemoryRecord, "sl" | "tl">): string {
	return `${languageName(record.sl)} → ${languageName(record.tl)}`;
}

interface MemoryEditState {
	readonly sourceText: string;
	readonly targetText: string;
	readonly sl: string;
	readonly tl: string;
	readonly glossaryVersion: string;
	readonly styleId: string;
	readonly tier: string;
}

function editState(record: TranslationMemoryRecord): MemoryEditState {
	return {
		sourceText: record.sourceText,
		targetText: record.targetText,
		sl: record.sl,
		tl: record.tl,
		glossaryVersion: record.glossaryVersion,
		styleId: record.styleId,
		tier: record.tier,
	};
}

export function MemoryPage() {
	const [store, setStore] = useState<MemoryStore | undefined>(undefined);
	const [records, setRecords] = useState<readonly TranslationMemoryRecord[]>(
		[],
	);
	const [stats, setStats] = useState<MemoryStats | undefined>(undefined);
	const [hasMore, setHasMore] = useState(false);
	const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [keyword, setKeyword] = useState("");
	const [sourceFilter, setSourceFilter] = useState("");
	const [targetFilter, setTargetFilter] = useState("");
	const [originFilter, setOriginFilter] = useState<MemoryOriginFilter>("");
	const [since, setSince] = useState("");
	const [until, setUntil] = useState("");
	const [sort, setSort] = useState<MemorySort>("updatedAt");
	const [direction, setDirection] = useState<MemorySortDirection>("desc");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [confirming, setConfirming] = useState<string | "batch" | undefined>(
		undefined,
	);
	const [editing, setEditing] = useState<TranslationMemoryRecord | undefined>(
		undefined,
	);
	const [editForm, setEditForm] = useState<MemoryEditState | undefined>(
		undefined,
	);
	const [pendingImport, setPendingImport] = useState<
		{ readonly text: string; readonly tmx: boolean } | undefined
	>(undefined);
	const fileRef = useRef<HTMLInputElement>(null);
	const generation = useRef(0);

	const filter = useMemo<MemoryFilter>(
		() => ({
			...(keyword.trim() !== "" && { keyword: keyword.trim() }),
			...(sourceFilter !== "" && { sl: sourceFilter }),
			...(targetFilter !== "" && { tl: targetFilter }),
			...(originFilter !== "" && { origin: originFilter }),
			...(dateBoundary(since) !== undefined && {
				since: dateBoundary(since),
			}),
			...(dateBoundary(until, true) !== undefined && {
				until: dateBoundary(until, true),
			}),
		}),
		[keyword, originFilter, since, sourceFilter, targetFilter, until],
	);

	useEffect(() => {
		let cancelled = false;
		void openMemoryStore().then((result) => {
			if (cancelled) return;
			if (!result.ok || result.store === undefined) {
				logger.warn("translation-memory.ui.open-failed", {
					reason: "reason" in result ? result.reason : "store_unavailable",
				});
				setFailure("翻译记忆暂时不可用。请检查浏览器的本地存储权限。");
				setLoading(false);
				return;
			}
			setStore(result.store);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const reload = useCallback(async () => {
		if (!store) return;
		const currentGeneration = generation.current + 1;
		generation.current = currentGeneration;
		setLoading(true);
		try {
			const [page, currentStats] = await Promise.all([
				queryMemory(store, {
					filter,
					sort,
					direction,
					limit: PAGE_SIZE,
				}),
				store.stats(),
			]);
			if (currentGeneration !== generation.current) return;
			setRecords(page.records);
			setHasMore(page.hasMore);
			setNextCursor(page.nextCursor);
			setStats(currentStats);
			setSelected(new Set());
			setFailure(undefined);
		} catch (error) {
			if (currentGeneration !== generation.current) return;
			logger.warn("translation-memory.ui.load-failed", { error });
			setFailure("读取翻译记忆失败。");
		} finally {
			if (currentGeneration === generation.current) setLoading(false);
		}
	}, [direction, filter, sort, store]);

	useEffect(() => {
		const timer = setTimeout(() => void reload(), 250);
		return () => clearTimeout(timer);
	}, [reload]);

	async function loadMore() {
		if (!store || !hasMore || nextCursor === undefined || loading) return;
		setLoading(true);
		try {
			const page = await queryMemory(store, {
				filter,
				sort,
				direction,
				limit: PAGE_SIZE,
				cursor: nextCursor,
			});
			setRecords((current) => [...current, ...page.records]);
			setHasMore(page.hasMore);
			setNextCursor(page.nextCursor);
		} catch (error) {
			logger.warn("translation-memory.ui.load-more-failed", { error });
			setNotice("无法加载更多记录。");
		} finally {
			setLoading(false);
		}
	}

	function beginEdit(record: TranslationMemoryRecord) {
		setEditing(record);
		setEditForm(editState(record));
		setNotice(undefined);
	}

	async function saveEdit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!store || !editing || !editForm) return;
		const result = await updateMemory(store, editing.id, editForm);
		if (!result.ok) {
			setNotice(result.reason);
			return;
		}
		setEditing(undefined);
		setEditForm(undefined);
		setNotice("翻译记忆已更新。");
		await reload();
	}

	async function removeOne(id: string) {
		if (!store) return;
		if (confirming !== id) {
			setConfirming(id);
			return;
		}
		const removed = await deleteMemory(store, id);
		setConfirming(undefined);
		setNotice(removed ? "翻译记忆已删除。" : "记录已经不存在。");
		await reload();
	}

	async function removeSelected() {
		if (!store || selected.size === 0) return;
		if (confirming !== "batch") {
			setConfirming("batch");
			return;
		}
		const count = await deleteMemories(store, [...selected]);
		setConfirming(undefined);
		setNotice(`已删除 ${count} 条翻译记忆。`);
		await reload();
	}

	async function exportRecords(kind: "json" | "tmx") {
		if (!store) return;
		const content =
			kind === "json"
				? await exportMemoryJson(store, filter)
				: await exportMemoryTmx(store, filter);
		downloadText(
			content,
			`mintranslate-memory.${kind}`,
			kind === "json" ? "application/json" : "application/xml",
		);
		setNotice(`已导出当前筛选结果。`);
	}

	async function handleFile(file: File) {
		try {
			setPendingImport({
				text: await file.text(),
				tmx: file.name.toLocaleLowerCase().endsWith(".tmx"),
			});
			setNotice("准备导入翻译记忆。");
		} catch {
			setNotice("无法读取导入文件。");
		}
	}

	async function applyImport() {
		if (!store || !pendingImport) return;
		let result: MemoryImportResult;
		try {
			result = pendingImport.tmx
				? await importMemoryTmx(store, pendingImport.text)
				: await importMemoryJson(store, pendingImport.text);
		} catch (error) {
			logger.warn("translation-memory.ui.import-failed", { error });
			setPendingImport(undefined);
			setNotice("导入文件格式不正确。");
			return;
		}
		setPendingImport(undefined);
		setNotice(
			`导入完成：新增或更新 ${result.imported}，跳过 ${result.skipped}。${result.reasons.length > 0 ? ` 原因：${result.reasons.join("；")}` : ""}`,
		);
		await reload();
	}

	function renderStat(label: string, value: string | number) {
		return (
			<div
				className="min-w-32 rounded-sm border border-border bg-surface p-4"
				key={label}
			>
				<p className="text-muted-foreground text-xs">{label}</p>
				<p className="mt-2 font-semibold text-lg">{value}</p>
			</div>
		);
	}

	return (
		<main className="page-wrap py-6 md:py-10">
			<header>
				<h1 className="display-title font-bold text-2xl md:text-3xl">
					翻译记忆
				</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
					查询和维护浏览器本地的段落级翻译记忆。记忆不会离开本设备。
				</p>
			</header>

			{stats && (
				<div className="mt-6 flex flex-wrap gap-4">
					{renderStat("总数", stats.total)}
					{renderStat("命中率", `${Math.round(stats.hitRate * 100)}%`)}
					{renderStat("语言对", Object.keys(stats.byLanguagePair).length)}
				</div>
			)}

			<div className="mt-6 grid gap-4 md:grid-cols-3">
				<label className="text-sm md:col-span-2">
					<span>关键字</span>
					<input
						id="memory-keyword"
						name="memory-keyword"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						placeholder="搜索原文或译文"
						value={keyword}
						onChange={(event) => setKeyword(event.target.value)}
					/>
				</label>
				<label className="text-sm">
					<span>来源</span>
					<select
						id="memory-origin"
						name="memory-origin"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={originFilter}
						onChange={(event) =>
							setOriginFilter(event.target.value as MemoryOriginFilter)
						}
					>
						{ORIGINS.map((origin) => (
							<option key={origin} value={origin}>
								{ORIGIN_LABEL[origin]}
							</option>
						))}
						<option value="">全部来源</option>
					</select>
				</label>
				<label className="text-sm">
					<span>源语言</span>
					<select
						id="memory-source-language"
						name="memory-source-language"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={sourceFilter}
						onChange={(event) => setSourceFilter(event.target.value)}
					>
						<option value="">全部源语言</option>
						{LANGUAGE_CODES.map((code) => (
							<option key={code} value={code}>
								{languageName(code)}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm">
					<span>目标语言</span>
					<select
						id="memory-target-language"
						name="memory-target-language"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={targetFilter}
						onChange={(event) => setTargetFilter(event.target.value)}
					>
						<option value="">全部目标语言</option>
						{LANGUAGE_CODES.map((code) => (
							<option key={code} value={code}>
								{languageName(code)}
							</option>
						))}
					</select>
				</label>
				<label className="text-sm">
					<span>更新时间从</span>
					<input
						type="date"
						id="memory-since"
						name="memory-since"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={since}
						onChange={(event) => setSince(event.target.value)}
					/>
				</label>
				<label className="text-sm">
					<span>更新时间至</span>
					<input
						type="date"
						id="memory-until"
						name="memory-until"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={until}
						onChange={(event) => setUntil(event.target.value)}
					/>
				</label>
				<label className="text-sm">
					<span>排序字段</span>
					<select
						id="memory-sort"
						name="memory-sort"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={sort}
						onChange={(event) => setSort(event.target.value as MemorySort)}
					>
						<option value="updatedAt">更新时间</option>
						<option value="hitCount">命中次数</option>
					</select>
				</label>
				<label className="text-sm">
					<span>排序方向</span>
					<select
						id="memory-direction"
						name="memory-direction"
						className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
						value={direction}
						onChange={(event) =>
							setDirection(event.target.value as MemorySortDirection)
						}
					>
						<option value="desc">降序</option>
						<option value="asc">升序</option>
					</select>
				</label>
			</div>

			<div className="mt-4 flex flex-wrap gap-2 text-sm">
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
					onClick={() => void exportRecords("json")}
				>
					导出 JSON
				</button>
				<button
					type="button"
					className="min-h-11 rounded-sm border border-border px-4"
					onClick={() => void exportRecords("tmx")}
				>
					导出 TMX
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
					id="memory-import-file"
					name="memory-import-file"
					type="file"
					accept=".json,.tmx,application/json,application/xml,text/xml"
					className="hidden"
					aria-label="导入翻译记忆文件"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void handleFile(file);
						event.target.value = "";
					}}
				/>
				{pendingImport && (
					<button
						type="button"
						className="min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground"
						onClick={() => void applyImport()}
					>
						确认导入
					</button>
				)}
			</div>

			{editing && editForm && (
				<form
					className="mt-4 rounded-sm border border-border bg-surface p-4"
					onSubmit={(event) => void saveEdit(event)}
				>
					<h2 className="font-semibold text-lg">编辑翻译记忆</h2>
					<div className="mt-4 grid gap-4 md:grid-cols-2">
						<label className="text-sm">
							<span>原文</span>
							<textarea
								id="memory-edit-source"
								name="source-text"
								required
								className="mt-2 min-h-24 w-full rounded-sm border border-input bg-background p-4"
								value={editForm.sourceText}
								onChange={(event) =>
									setEditForm({ ...editForm, sourceText: event.target.value })
								}
							/>
						</label>
						<label className="text-sm">
							<span>译文</span>
							<textarea
								id="memory-edit-target"
								name="target-text"
								required
								className="mt-2 min-h-24 w-full rounded-sm border border-input bg-background p-4"
								value={editForm.targetText}
								onChange={(event) =>
									setEditForm({ ...editForm, targetText: event.target.value })
								}
							/>
						</label>
						<label className="text-sm">
							<span>源语言</span>
							<select
								id="memory-edit-sl"
								name="sl"
								className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
								value={editForm.sl}
								onChange={(event) =>
									setEditForm({ ...editForm, sl: event.target.value })
								}
							>
								{LANGUAGE_CODES.map((code) => (
									<option key={code} value={code}>
										{languageName(code)}
									</option>
								))}
							</select>
						</label>
						<label className="text-sm">
							<span>目标语言</span>
							<select
								id="memory-edit-tl"
								name="tl"
								className="mt-2 min-h-11 w-full rounded-sm border border-input bg-background px-4"
								value={editForm.tl}
								onChange={(event) =>
									setEditForm({ ...editForm, tl: event.target.value })
								}
							>
								{LANGUAGE_CODES.map((code) => (
									<option key={code} value={code}>
										{languageName(code)}
									</option>
								))}
							</select>
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
							onClick={() => {
								setEditing(undefined);
								setEditForm(undefined);
							}}
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
				{loading
					? "读取中…"
					: `显示 ${records.length} 条记录${hasMore ? "，继续滚动加载" : ""}`}
			</p>

			<VirtualList
				className="mt-4 h-[60vh] min-h-60 overflow-y-auto rounded-sm border border-border"
				items={records}
				rowHeight={MEMORY_ROW_HEIGHT}
				onEndReached={() => void loadMore()}
				emptyState={
					<p className="p-6 text-muted-foreground text-sm">
						{loading ? "读取中…" : "没有匹配的翻译记忆。"}
					</p>
				}
				renderItem={(record) => (
					<div className="flex h-full items-start gap-4 border-border border-b p-4">
						<input
							type="checkbox"
							id={`memory-select-${record.id}`}
							name="memory-select"
							className="mt-2"
							aria-label="选择此翻译记忆"
							checked={selected.has(record.id)}
							onChange={(event) => {
								setSelected((current) => {
									const next = new Set(current);
									if (event.target.checked) next.add(record.id);
									else next.delete(record.id);
									return next;
								});
							}}
						/>
						<div className="min-w-0 flex-1 text-sm">
							<p className="break-words font-medium">{record.sourceText}</p>
							<p className="mt-2 break-words text-muted-foreground">
								{record.targetText}
							</p>
							<p className="mt-2 text-muted-foreground text-xs">
								{pairLabel(record)} · {ORIGIN_LABEL[record.origin]} · 命中{" "}
								{record.hitCount} 次 ·{" "}
								{new Date(record.updatedAt).toLocaleString()}
							</p>
						</div>
						<div className="flex shrink-0 flex-wrap gap-2 text-xs">
							<button
								type="button"
								className="min-h-11 rounded-sm border border-border px-4"
								onClick={() => beginEdit(record)}
							>
								编辑
							</button>
							<button
								type="button"
								className="min-h-11 rounded-sm border border-border px-4"
								onClick={() => void removeOne(record.id)}
							>
								{confirming === record.id ? "确认删除" : "删除"}
							</button>
						</div>
					</div>
				)}
			/>
		</main>
	);
}
