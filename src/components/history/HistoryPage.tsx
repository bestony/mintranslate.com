/**
 * History page.
 *
 * Composition only: it opens the database, drives the query and transfer
 * layers, and renders. All the rules live in `src/lib/history/*` and are tested
 * there.
 *
 * Nothing here contacts the network — history is local by definition, which is
 * also what makes the page usable offline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistoryFilter } from "#/lib/history/db";
import {
	buildExportPayload,
	clearAll,
	countRecords,
	DEFAULT_RECORD_LIMIT,
	deleteRecord,
	deleteRecords,
	evictOverLimit,
	importRecords as importIntoStore,
	type OpenResult,
	openHistoryDatabase,
	readAll,
	readByIds,
	readPage,
	searchRecords,
	setFavorite,
} from "#/lib/history/db";
import type { HistoryRecord } from "#/lib/history/model";
import {
	detectPayloadKind,
	type ExportScope,
	exportFileName,
	exportMimeType,
	parseCsvExport,
	parseJsonExport,
	selectForExport,
	toCsv,
} from "#/lib/history/transfer";
import { languageName } from "#/lib/languages";
import { logger } from "#/lib/logger";
import { LANGUAGE_OPTIONS } from "./languageOptions";
import { useDebouncedSearch } from "./useDebouncedSearch";
import { ROW_HEIGHT, VirtualList } from "./VirtualList";

/** Page size for the list. */
const PAGE_SIZE = 30;

/** Outcome of an import, shown to the user. */
interface ImportReport {
	readonly imported: number;
	readonly skipped: number;
	readonly reasons: readonly string[];
}

export function HistoryPage() {
	const [opened, setOpened] = useState<OpenResult | undefined>(undefined);
	const [records, setRecords] = useState<readonly HistoryRecord[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [total, setTotal] = useState(0);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [importReport, setImportReport] = useState<ImportReport | undefined>(
		undefined,
	);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [favoritesOnly, setFavoritesOnly] = useState(false);
	const [sourceLang, setSourceLang] = useState("");
	const [targetLang, setTargetLang] = useState("");
	const [confirming, setConfirming] = useState<"clear" | "batch" | undefined>(
		undefined,
	);
	const fileRef = useRef<HTMLInputElement>(null);

	const db = opened?.ok === true ? opened.db : undefined;

	// Open once. A failure is a reported state, not an exception: history is
	// optional and translation must not depend on it.
	useEffect(() => {
		let cancelled = false;
		void openHistoryDatabase().then((result) => {
			if (cancelled) return;
			setOpened(result);
			if (!result.ok) {
				logger.warn("history.open.failed", { reason: result.reason });
				return;
			}
			logger.debug("history.open.ready");
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const filter: HistoryFilter = useMemo(
		() => ({
			...(favoritesOnly && { favoritesOnly: true }),
			...(sourceLang !== "" && { sourceLang }),
			...(targetLang !== "" && { targetLang }),
		}),
		[favoritesOnly, sourceLang, targetLang],
	);

	/** Load the first page for the current filter. */
	const reload = useCallback(async () => {
		if (!db) return;
		try {
			const page = await readPage(db, { limit: PAGE_SIZE, filter });
			setRecords(page.records);
			setHasMore(page.hasMore);
			setTotal(await countRecords(db));
		} catch (error) {
			logger.error("history.load.failed", { error });
			setFailure("读取历史失败。");
		}
	}, [db, filter]);

	useEffect(() => {
		void reload();
	}, [reload]);

	/** The search path: cursor scan with early termination, debounced. */
	const search = useDebouncedSearch(
		useCallback(
			async (keyword: string, _signal: AbortSignal) => {
				if (!db)
					return { records: [] as readonly HistoryRecord[], hasMore: false };
				return searchRecords(db, keyword, { limit: PAGE_SIZE, filter });
			},
			[db, filter],
		),
	);

	// When a search is active it owns the list; otherwise the paginated read does.
	const searching = search.input.trim() !== "";
	const shown = searching ? (search.result?.records ?? []) : records;
	const shownHasMore = searching ? (search.result?.hasMore ?? false) : hasMore;

	/** Append the next page of the list. */
	async function loadMore() {
		if (!db || !shownHasMore) return;
		// Pagination applies to browsing. A search result page is already the
		// complete answer for its window, so a search simply shows its first page
		// and the user refines the keyword instead of paging.
		if (searching) return;

		try {
			const next = await readPage(db, {
				offset: records.length,
				limit: PAGE_SIZE,
				filter,
			});
			setRecords((current) => [...current, ...next.records]);
			setHasMore(next.hasMore);
		} catch (error) {
			logger.error("history.loadMore.failed", { error });
		}
	}

	// Warn (without deleting) when the retained count exceeds the cap. Favourites
	// are exempt from eviction, so a store full of favourites can exceed it.
	const overLimit = total > DEFAULT_RECORD_LIMIT && !favoritesOnly;

	async function toggleFavorite(record: HistoryRecord) {
		if (!db) return;
		await setFavorite(db, record.id, !record.favorite);
		logger.debug("history.favorite.toggled", { favorite: !record.favorite });
		await reload();
	}

	async function removeOne(record: HistoryRecord) {
		if (!db) return;
		await deleteRecord(db, record.id);
		logger.info("history.record.deleted", { count: 1 });
		setSelected((current) => {
			const next = new Set(current);
			next.delete(record.id);
			return next;
		});
		await reload();
	}

	async function confirmBatchDelete() {
		if (!db) return;
		const ids = [...selected];
		await deleteRecords(db, ids);
		// The count is logged rather than the contents: records are user text.
		logger.info("history.records.deleted", { count: ids.length });
		setSelected(new Set());
		setConfirming(undefined);
		await reload();
	}

	async function confirmClear() {
		if (!db) return;
		await clearAll(db);
		logger.warn("history.cleared");
		setConfirming(undefined);
		await reload();
	}

	/** Build the payload for the requested scope and hand it to the browser. */
	async function runExport(kind: "json" | "csv", scope: ExportScope) {
		if (!db) return;
		// `all` reads everything: an export must not be limited by the UI page size.
		const source =
			scope === "all" ? await readAll(db) : await readByIds(db, [...selected]);
		const chosen = selectForExport(source, scope, [...selected]);

		const content =
			kind === "json"
				? JSON.stringify(
						buildExportPayload(chosen, new Date().toISOString()),
						null,
						2,
					)
				: toCsv(chosen);

		const blob = new Blob([content], { type: exportMimeType(kind) });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = exportFileName(kind, new Date());
		anchor.click();
		URL.revokeObjectURL(url);

		logger.info("history.exported", { kind, scope, count: chosen.length });
		setNotice(`已导出 ${chosen.length} 条记录（${kind.toUpperCase()}）。`);
	}

	/** Parse a chosen file and merge it in. */
	async function handleFile(file: File) {
		if (!db) return;
		try {
			const text = await file.text();
			const kind = detectPayloadKind(text);
			const parsed =
				kind === "json" ? parseJsonExport(text) : parseCsvExport(text);

			if (!parsed.ok) {
				logger.warn("history.import.rejected", { reason: parsed.reason });
				setImportReport(undefined);
				setFailure(`导入失败：${parsed.reason}`);
				return;
			}

			const result = await importIntoStore(db, parsed.records);
			logger.info("history.imported", {
				imported: result.imported,
				skipped: result.skipped + parsed.skipped,
			});
			setFailure(undefined);
			setImportReport({
				imported: result.imported,
				skipped: result.skipped + parsed.skipped,
				reasons: [...parsed.reasons, ...result.reasons],
			});
			await evictOverLimit(db, DEFAULT_RECORD_LIMIT);
			await reload();
		} catch (error) {
			logger.error("history.import.failed", { error });
			setFailure("导入失败：无法读取该文件。");
		}
	}

	// Storage unavailable: state the limitation and keep the rest of the app usable.
	if (opened !== undefined && !opened.ok) {
		return (
			<main className="page-wrap py-10">
				<h1 className="display-title font-bold text-3xl">历史记录</h1>
				<p className="mt-4 rounded-md border border-border bg-surface p-3 text-sm">
					当前环境无法使用本地历史：{opened.reason}。翻译功能不受影响。
				</p>
			</main>
		);
	}

	return (
		<main className="page-wrap py-6 md:py-10">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="display-title font-bold text-2xl md:text-3xl">
					历史记录
				</h1>
				<span className="text-muted-foreground text-sm">
					共 {total} 条{selected.size > 0 && ` · 已选 ${selected.size} 条`}
				</span>
			</div>

			{overLimit && (
				<p className="mt-3 rounded-md border border-border bg-surface p-3 text-sm">
					本地记录已超过 {DEFAULT_RECORD_LIMIT} 条上限（收藏项不会被自动清理）。
					建议导出备份后清理部分记录。
				</p>
			)}

			{/* Filters */}
			<div className="mt-4 flex flex-wrap items-center gap-3">
				<input
					id="history-search"
					name="history-search"
					aria-label="搜索历史记录"
					className="min-h-11 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
					placeholder="搜索原文或译文"
					value={search.input}
					onChange={(event) => search.setInput(event.target.value)}
				/>

				<label className="flex min-h-11 items-center gap-2 text-sm">
					<input
						type="checkbox"
						id="history-favorites-only"
						name="history-favorites-only"
						checked={favoritesOnly}
						onChange={(event) => setFavoritesOnly(event.target.checked)}
					/>
					只看收藏
				</label>

				<select
					id="history-source-language"
					name="history-source-language"
					aria-label="按源语言筛选"
					className="min-h-11 rounded-md border border-input bg-background px-3 text-sm"
					value={sourceLang}
					onChange={(event) => setSourceLang(event.target.value)}
				>
					<option value="">源语言（全部）</option>
					{LANGUAGE_OPTIONS.map((code) => (
						<option key={code} value={code}>
							{languageName(code)}
						</option>
					))}
				</select>

				<select
					id="history-target-language"
					name="history-target-language"
					aria-label="按目标语言筛选"
					className="min-h-11 rounded-md border border-input bg-background px-3 text-sm"
					value={targetLang}
					onChange={(event) => setTargetLang(event.target.value)}
				>
					<option value="">目标语言（全部）</option>
					{LANGUAGE_OPTIONS.map((code) => (
						<option key={code} value={code}>
							{languageName(code)}
						</option>
					))}
				</select>
			</div>

			{/* Actions */}
			<div className="mt-4 flex flex-wrap gap-2 text-sm">
				<button
					type="button"
					className="rounded-md border border-input min-h-11 px-3 disabled:opacity-40"
					disabled={selected.size === 0}
					onClick={() =>
						setConfirming(confirming === "batch" ? undefined : "batch")
					}
				>
					批量删除（{selected.size}）
				</button>

				{confirming === "batch" && (
					<>
						<button
							type="button"
							className="rounded-md bg-primary-strong min-h-11 px-3 text-primary-foreground"
							onClick={confirmBatchDelete}
						>
							确认删除
						</button>
						<button
							type="button"
							className="rounded-md border border-input min-h-11 px-3"
							onClick={() => setConfirming(undefined)}
						>
							取消
						</button>
					</>
				)}

				<button
					type="button"
					className="rounded-md border border-input min-h-11 px-3"
					onClick={() => runExport("json", "all")}
				>
					导出全部 JSON
				</button>
				<button
					type="button"
					className="rounded-md border border-input min-h-11 px-3"
					onClick={() => runExport("csv", "all")}
				>
					导出全部 CSV
				</button>
				<button
					type="button"
					className="rounded-md border border-input min-h-11 px-3 disabled:opacity-40"
					disabled={selected.size === 0}
					onClick={() => runExport("json", "selected")}
				>
					导出选中 JSON
				</button>
				<button
					type="button"
					className="rounded-md border border-input min-h-11 px-3"
					onClick={() => fileRef.current?.click()}
				>
					导入
				</button>
				<input
					ref={fileRef}
					id="history-import-file"
					name="history-import-file"
					type="file"
					accept=".json,.csv,application/json,text/csv"
					className="hidden"
					onChange={(event) => {
						const file = event.target.files?.[0];
						if (file) void handleFile(file);
						event.target.value = "";
					}}
				/>

				<button
					type="button"
					className={
						confirming === "clear"
							? "min-h-11 rounded-md bg-primary-strong px-4 text-primary-foreground"
							: "ml-auto min-h-11 rounded-md border border-border px-4"
					}
					onClick={() => {
						if (confirming === "clear") void confirmClear();
						else setConfirming("clear");
					}}
				>
					{confirming === "clear" ? "确认清空全部历史？" : "清空历史"}
				</button>
				{confirming === "clear" && (
					<button
						type="button"
						className="rounded-md border border-input min-h-11 px-3"
						onClick={() => setConfirming(undefined)}
					>
						取消
					</button>
				)}
			</div>

			{failure !== undefined && (
				<p className="mt-3 rounded-md border border-border bg-surface p-3 text-sm">
					{failure}
				</p>
			)}

			{importReport !== undefined && (
				<p className="mt-3 rounded-md border border-border bg-surface p-3 text-sm">
					导入完成：新增/更新 {importReport.imported} 条，跳过{" "}
					{importReport.skipped} 条。
					{importReport.reasons.length > 0 && (
						<span className="text-muted-foreground">
							{" "}
							原因示例：{importReport.reasons.join("；")}
						</span>
					)}
				</p>
			)}

			{notice !== undefined && (
				<p className="mt-3 text-muted-foreground text-sm">{notice}</p>
			)}

			{search.pending && (
				<p className="mt-3 text-muted-foreground text-sm">搜索中…</p>
			)}

			{/* List */}
			<VirtualList
				className="mt-4 h-[60vh] overflow-y-auto rounded-md border border-border"
				items={shown}
				rowHeight={ROW_HEIGHT}
				onEndReached={() => {
					if (shownHasMore) void loadMore();
				}}
				emptyState={
					<p className="p-6 text-muted-foreground text-sm">
						{searching
							? "没有匹配的记录。"
							: favoritesOnly
								? "还没有收藏的记录。"
								: "还没有历史记录。翻译成功后会自动保存到这里。"}
					</p>
				}
				renderItem={(record) => (
					<div className="flex h-full items-start gap-3 border-border border-b min-h-11 px-3">
						<input
							type="checkbox"
							id={`history-select-${record.id}`}
							name="history-select"
							className="mt-1"
							aria-label="选择此记录"
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

						<div className="min-w-0 flex-1">
							{/* Plain text nodes: React escapes them, so imported HTML cannot render. */}
							<p className="truncate text-sm">{record.sourceText}</p>
							<p className="truncate text-muted-foreground text-sm">
								{record.targetText}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{languageName(record.sourceLang)} →{" "}
								{languageName(record.targetLang)}
								{record.model !== "" && ` · ${record.model}`}
								{` · ${new Date(record.updatedAt).toLocaleString()}`}
							</p>
						</div>

						<div className="flex shrink-0 gap-2 text-xs">
							<button
								type="button"
								className="nav-link min-h-11 inline-flex items-center"
								aria-pressed={record.favorite}
								onClick={() => void toggleFavorite(record)}
							>
								{record.favorite ? "已收藏" : "收藏"}
							</button>
							<button
								type="button"
								className="nav-link min-h-11 inline-flex items-center"
								onClick={() => void removeOne(record)}
							>
								删除
							</button>
						</div>
					</div>
				)}
			/>
		</main>
	);
}
