import { useCallback, useEffect, useRef, useState } from "react";

import type { Analytics } from "#/lib/analytics/track";
import { attributeFailure } from "#/lib/connections/attribution";
import type { Connection } from "#/lib/connections/model";
import {
	deliveredFileName,
	EMPTY_DOCUMENT_NOTICE,
	taskThresholdNotice,
	taskTrigger,
	unparsableReason,
	validateDocument,
} from "#/lib/document";
import {
	pdfComparisonText,
	replacementsFromTask,
} from "#/lib/document/delivery";
import type { TextChunk } from "#/lib/document/model";
import {
	completedChunkCount,
	type DocumentFormat,
	type DocumentTaskRecord,
} from "#/lib/document/model";
import {
	chunksFromPdfExtraction,
	type PdfExtraction,
} from "#/lib/document/pdf";
import { runDocumentJob } from "#/lib/document/runner";
import { progressOf, resetResultsForContext } from "#/lib/document/task";
import {
	createTaskRecord,
	type DocumentTaskStore,
	openDocumentTaskStore,
} from "#/lib/document/task-store";
import { translateDocument } from "#/lib/document/translation";
import { getGlossaryVersion, matchTerms } from "#/lib/glossary";
import { logger } from "#/lib/logger";
import {
	getDefaultTranslationMemoryStore,
	readTranslationMemoryEnabled,
} from "#/lib/translation-memory";
import { DocumentDropZone } from "./DocumentDropZone";
import { DocumentResultView } from "./DocumentResultView";
import {
	bindDocumentRunTask,
	canDeleteDocumentTask,
	canStartDocumentRun,
	type DocumentRunReservation,
	hasResumableSource,
	ownsDocumentRun,
	reserveDocumentRun,
	shouldDisableDeleteDocumentTask,
	shouldDisableResume,
} from "./task-actions";

interface DocumentTranslationModeProps {
	readonly connection: Connection | undefined;
	readonly apiKey: string;
	readonly sourceLang: string;
	readonly targetLang: string;
	readonly styleId: string;
	readonly customInstruction?: string;
	readonly analytics: Analytics;
}

interface ParsedInput {
	readonly format: DocumentFormat;
	readonly chunks: readonly TextChunk[];
	readonly pageCount?: number;
	readonly pdf?: PdfExtraction;
}

const MIME_TYPES: Record<Exclude<DocumentFormat, "pdf">, string> = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function newTaskId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
		return crypto.randomUUID();
	return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function parseInput(
	bytes: Uint8Array,
	format: DocumentFormat,
): Promise<ParsedInput> {
	if (format === "pdf") {
		const result = await runDocumentJob({ kind: "extract-pdf", bytes });
		if (result.kind !== "pdf") throw new Error("PDF 提取没有返回文本结果");
		return {
			format,
			chunks: chunksFromPdfExtraction(result.extraction),
			pageCount: result.extraction.pageCount,
			pdf: result.extraction,
		};
	}

	const result = await runDocumentJob({ kind: "parse", bytes, format });
	if (result.kind !== "parsed") throw new Error("文档解析没有返回文本结果");
	return {
		format,
		chunks: result.document.chunks,
		pageCount: result.document.pageCount,
	};
}

function resultMime(format: DocumentFormat): string {
	return format === "pdf" ? "text/plain;charset=utf-8" : MIME_TYPES[format];
}

const CANCEL_NOTICE =
	"已取消，已完成的块已保留；如果原文件已清理，请重新上传。";

async function sourceAvailabilityFor(
	currentStore: DocumentTaskStore,
	entries: readonly DocumentTaskRecord[],
): Promise<ReadonlyMap<string, boolean>> {
	const available = await Promise.all(
		entries.map(async (entry) => {
			try {
				return [entry.id, await currentStore.hasSource(entry.id)] as const;
			} catch (error) {
				logger.warn("document.ui.source-check-failed", {
					reason: error instanceof Error ? error.message : String(error),
				});
				return [entry.id, false] as const;
			}
		}),
	);
	return new Map(available);
}

/** Upload, resume, translate, and deliver one document. */
export function DocumentTranslationMode({
	connection,
	apiKey,
	sourceLang,
	targetLang,
	styleId,
	customInstruction,
	analytics,
}: DocumentTranslationModeProps) {
	const [store, setStore] = useState<DocumentTaskStore | undefined>(undefined);
	const storeRef = useRef<DocumentTaskStore | undefined>(undefined);
	const [tasks, setTasks] = useState<readonly DocumentTaskRecord[]>([]);
	const [sourceAvailability, setSourceAvailability] = useState<
		ReadonlyMap<string, boolean>
	>(() => new Map());
	const [task, setTask] = useState<DocumentTaskRecord | undefined>(undefined);
	const [format, setFormat] = useState<DocumentFormat | undefined>(undefined);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [empty, setEmpty] = useState(false);
	const [threshold, setThreshold] = useState<string>(taskThresholdNotice());
	const [downloadUrl, setDownloadUrl] = useState<string | undefined>(undefined);
	const [downloadName, setDownloadName] = useState<string | undefined>(
		undefined,
	);
	const runReservationRef = useRef<DocumentRunReservation | undefined>(
		undefined,
	);
	const [runReservation, setRunReservation] = useState<
		DocumentRunReservation | undefined
	>(undefined);

	const reserveRun = useCallback((taskId?: string) => {
		const reservation = reserveDocumentRun(
			runReservationRef.current,
			new AbortController(),
			taskId,
		);
		if (reservation === undefined) return undefined;
		runReservationRef.current = reservation;
		setRunReservation(reservation);
		return reservation;
	}, []);

	const bindRunTask = useCallback(
		(reservation: DocumentRunReservation, taskId: string) => {
			if (!ownsDocumentRun(runReservationRef.current, reservation))
				return reservation;
			const bound = bindDocumentRunTask(reservation, taskId);
			runReservationRef.current = bound;
			setRunReservation(bound);
			return bound;
		},
		[],
	);

	const releaseRun = useCallback((reservation: DocumentRunReservation) => {
		if (!ownsDocumentRun(runReservationRef.current, reservation)) return;
		runReservationRef.current = undefined;
		setRunReservation(undefined);
	}, []);

	useEffect(() => {
		let disposed = false;
		void openDocumentTaskStore().then(async (opened) => {
			if (disposed) return;
			storeRef.current = opened;
			setStore(opened);
			if (opened) {
				const listed = await opened.list();
				if (disposed) return;
				setTasks(listed);
				setSourceAvailability(
					await sourceAvailabilityFor(opened, listed.slice(0, 5)),
				);
			}
		});
		return () => {
			disposed = true;
			runReservationRef.current?.controller.abort();
		};
	}, []);

	useEffect(() => {
		if (downloadUrl === undefined) return;
		return () => URL.revokeObjectURL(downloadUrl);
	}, [downloadUrl]);

	const clearDownload = useCallback(() => {
		setDownloadUrl((current) => {
			if (current !== undefined) URL.revokeObjectURL(current);
			return undefined;
		});
		setDownloadName(undefined);
	}, []);

	const refreshTasks = useCallback(async (currentStore: DocumentTaskStore) => {
		const listed = await currentStore.list();
		setTasks(listed);
		setSourceAvailability(
			await sourceAvailabilityFor(currentStore, listed.slice(0, 5)),
		);
	}, []);

	const deliver = useCallback(
		async (
			record: DocumentTaskRecord,
			source: Uint8Array,
			parsedPdf: PdfExtraction | undefined,
			currentStore: DocumentTaskStore,
		) => {
			let bytes: Uint8Array;
			if (record.format === "pdf") {
				if (parsedPdf === undefined) throw new Error("缺少 PDF 提取结果");
				bytes = new TextEncoder().encode(pdfComparisonText(parsedPdf, record));
			} else {
				const rebuilt = await runDocumentJob({
					kind: "rebuild",
					bytes: source,
					format: record.format,
					replacements: replacementsFromTask(record),
				});
				if (rebuilt.kind !== "rebuilt") throw new Error("译稿重建没有返回文件");
				bytes = rebuilt.bytes;
			}

			const nextUrl = URL.createObjectURL(
				new Blob([bytes as unknown as BlobPart], {
					type: resultMime(record.format),
				}),
			);
			clearDownload();
			setDownloadUrl(nextUrl);
			setDownloadName(deliveredFileName(record.fileName, record.targetLang));
			await currentStore.dropSource(record.id);
			await refreshTasks(currentStore);
		},
		[clearDownload, refreshTasks],
	);

	const runTask = useCallback(
		async (
			record: DocumentTaskRecord,
			source: Uint8Array,
			parsedPdf: PdfExtraction | undefined,
			currentStore: DocumentTaskStore,
			reservation: DocumentRunReservation,
		) => {
			if (
				canStartDocumentRun(runReservationRef.current) ||
				!ownsDocumentRun(runReservationRef.current, reservation)
			)
				return;
			if (connection === undefined) {
				setNotice("还没有可用的连接。请先在设置页配置一个支持文本输入的模型。");
				return;
			}
			const controller = reservation.controller;
			setTask(record);
			setNotice(undefined);
			try {
				const pair = { sl: record.sourceLang, tl: record.targetLang };
				const glossaryVersion = await getGlossaryVersion(pair);
				const memory = readTranslationMemoryEnabled()
					? await getDefaultTranslationMemoryStore()
					: undefined;
				const outcome = await translateDocument(
					{
						record,
						connection,
						apiKey,
						customInstruction,
						signal: controller.signal,
					},
					{
						glossaryVersion,
						glossaryMatcher: matchTerms,
						memory,
						onUpdate: (next) => {
							setTask(next);
							return currentStore.save(next);
						},
					},
				);
				setTask(outcome.record);
				if (outcome.kind === "cancelled") {
					setNotice(CANCEL_NOTICE);
					return;
				}
				if (outcome.kind === "failed") {
					setNotice(outcome.attribution.summary);
					analytics.track("translate_error", {
						mode: "docs",
						provider: connection.provider,
						model: connection.model,
						error_type: outcome.attribution.type,
					});
					return;
				}

				await deliver(outcome.record, source, parsedPdf, currentStore);
				analytics.track("translate_success", {
					mode: "docs",
					source_lang: outcome.record.sourceLang,
					target_lang: outcome.record.targetLang,
					provider: connection.provider,
					model: connection.model,
					latency_ms: 0,
					is_streaming: false,
				});
				await refreshTasks(currentStore);
			} catch (error) {
				if (controller.signal.aborted) {
					setNotice(CANCEL_NOTICE);
					return;
				}
				logger.warn("document.ui.failed", {
					reason: error instanceof Error ? error.message : String(error),
				});
				const attribution = attributeFailure({ error });
				setNotice(attribution.summary);
			} finally {
				// The submit or resume owner releases the reservation in its outer
				// finally, including setup failures before this function is called.
			}
		},
		[analytics, apiKey, connection, customInstruction, deliver, refreshTasks],
	);

	const submit = useCallback(
		async (file: File) => {
			const reserved = reserveRun();
			if (reserved === undefined) return;
			let reservation = reserved;
			let storageWriteStarted = false;
			try {
				clearDownload();
				setNotice(undefined);
				setEmpty(false);
				setFormat(undefined);
				setTask(undefined);
				const validation = validateDocument({
					name: file.name,
					type: file.type,
					size: file.size,
				});
				if (!validation.ok) {
					setNotice(validation.reason);
					return;
				}

				const currentStore =
					storeRef.current ?? (await openDocumentTaskStore());
				if (currentStore === undefined) {
					setNotice("本地任务存储不可用，无法保存进度。");
					return;
				}
				storeRef.current = currentStore;
				setStore(currentStore);

				const bytes = new Uint8Array(await file.arrayBuffer());
				const parsed = await parseInput(bytes, validation.format);
				setFormat(parsed.format);
				if (parsed.chunks.length === 0) {
					setEmpty(true);
					setNotice(EMPTY_DOCUMENT_NOTICE);
					return;
				}
				const trigger = taskTrigger({
					size: file.size,
					pageCount: parsed.pageCount,
				});
				setThreshold(
					trigger === "none"
						? taskThresholdNotice()
						: `${taskThresholdNotice()} 本次文档因${trigger === "pages" ? "页数" : "体积"}超过阈值，已保存为任务。`,
				);
				const created = createTaskRecord({
					id: newTaskId(),
					fileName: file.name,
					format: validation.format,
					sourceLang,
					targetLang,
					styleId,
					chunks: parsed.chunks.map((chunk) => ({ chunk })),
					now: Date.now(),
				});
				reservation = bindRunTask(reservation, created.id);
				storageWriteStarted = true;
				await currentStore.dropStaleSources(created.id);
				await currentStore.save(created);
				await currentStore.saveSource(created.id, bytes);
				setTask(created);
				await refreshTasks(currentStore);
				analytics.track("translate_submit", {
					mode: "docs",
					source_lang: sourceLang,
					target_lang: targetLang,
					input_chars: parsed.chunks.reduce(
						(sum, chunk) => sum + chunk.text.length,
						0,
					),
					input_kind: "document",
				});
				await runTask(created, bytes, parsed.pdf, currentStore, reservation);
			} catch (error) {
				logger.warn("document.ui.submit-failed", {
					phase: storageWriteStarted ? "storage" : "parse",
					reason: error instanceof Error ? error.message : String(error),
				});
				setNotice(
					storageWriteStarted
						? "本地任务存储写入失败，无法保存进度，请重试。"
						: unparsableReason(file.name),
				);
			} finally {
				releaseRun(reservation);
			}
		},
		[
			analytics,
			clearDownload,
			bindRunTask,
			releaseRun,
			refreshTasks,
			reserveRun,
			runTask,
			sourceLang,
			styleId,
			targetLang,
		],
	);

	const resume = useCallback(
		async (candidate: DocumentTaskRecord) => {
			const reservation = reserveRun(candidate.id);
			if (reservation === undefined) return;
			try {
				const currentStore = storeRef.current;
				if (currentStore === undefined) {
					setNotice("本地任务存储不可用，无法续传。");
					return;
				}
				const source = await currentStore.loadSource(candidate.id);
				if (source === undefined) {
					setNotice("原文件已清理，无法续传；请重新上传。");
					return;
				}
				const current = resetResultsForContext(
					candidate,
					{ sourceLang, targetLang, styleId },
					Date.now(),
				);
				if (current !== candidate) {
					await currentStore.save(current);
					await refreshTasks(currentStore);
				}
				setFormat(current.format);
				setEmpty(false);
				setNotice(undefined);
				let parsedPdf: PdfExtraction | undefined;
				if (current.format === "pdf") {
					try {
						const parsed = await parseInput(source, "pdf");
						parsedPdf = parsed.pdf;
					} catch {
						setNotice(unparsableReason(current.fileName));
						return;
					}
				}
				await runTask(current, source, parsedPdf, currentStore, reservation);
			} finally {
				releaseRun(reservation);
			}
		},
		[
			refreshTasks,
			releaseRun,
			reserveRun,
			runTask,
			sourceLang,
			styleId,
			targetLang,
		],
	);

	const cancel = useCallback(() => {
		runReservationRef.current?.controller.abort();
	}, []);

	const remove = useCallback(
		async (id: string) => {
			const currentStore = storeRef.current;
			if (currentStore === undefined) return;
			await currentStore.remove(id);
			if (task?.id === id) setTask(undefined);
			await refreshTasks(currentStore);
		},
		[refreshTasks, task?.id],
	);

	const progress = task === undefined ? undefined : progressOf(task);
	const activeTask = task?.state === "queued" || task?.state === "processing";

	return (
		<section className="flex min-h-0 flex-col" aria-label="文档翻译">
			<DocumentDropZone
				disabled={runReservation !== undefined}
				onAccept={(file) => void submit(file)}
				onReject={setNotice}
			/>
			<p className="mt-4 text-muted-foreground text-xs">{threshold}</p>

			{notice !== undefined && !empty && (
				<p className="mt-4 text-sm" role="alert">
					{notice}
				</p>
			)}

			{progress !== undefined && (
				<div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
					<p aria-live="polite">
						{task?.state === "queued"
							? "排队中"
							: task?.state === "processing"
								? `处理中：${completedChunkCount(task)} / ${progress.total} 个块`
								: task?.state === "succeeded"
									? "处理完成"
									: task?.failureKind === "cancelled"
										? "已取消"
										: "处理失败"}
					</p>
					{activeTask && (
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-4 text-xs"
							onClick={cancel}
						>
							取消
						</button>
					)}
				</div>
			)}

			{empty && (
				<DocumentResultView
					format={format}
					empty
					notice={EMPTY_DOCUMENT_NOTICE}
				/>
			)}
			{!empty && (
				<DocumentResultView
					format={format}
					downloadUrl={downloadUrl}
					downloadName={downloadName}
				/>
			)}

			{tasks.length > 0 && (
				<section
					className="mt-4 rounded-md border border-border p-4"
					aria-label="文档任务"
				>
					<h2 className="text-sm">最近的文档任务</h2>
					<ul className="mt-4 space-y-2">
						{tasks.slice(0, 5).map((entry) => (
							<li
								key={entry.id}
								className="flex flex-wrap items-center justify-between gap-2 text-xs"
							>
								<span>
									{entry.fileName} · {completedChunkCount(entry)} /{" "}
									{entry.chunks.length}
								</span>
								<div className="flex flex-wrap gap-2">
									{hasResumableSource(
										entry,
										sourceAvailability.get(entry.id) === true,
									) && (
										<button
											type="button"
											className="nav-link min-h-11"
											disabled={shouldDisableResume(runReservation)}
											onClick={() => void resume(entry)}
										>
											继续
										</button>
									)}
									{sourceAvailability.has(entry.id) &&
										entry.state !== "succeeded" &&
										!hasResumableSource(
											entry,
											sourceAvailability.get(entry.id) === true,
										) && (
											<span className="text-muted-foreground">
												原文件已清理，无法续传；请重新上传。
											</span>
										)}
									{canDeleteDocumentTask(entry, task?.id, activeTask) && (
										<button
											type="button"
											className="nav-link min-h-11"
											disabled={shouldDisableDeleteDocumentTask(
												entry,
												runReservation,
											)}
											onClick={() => void remove(entry.id)}
										>
											删除
										</button>
									)}
								</div>
							</li>
						))}
					</ul>
				</section>
			)}

			{store === undefined && (
				<p className="mt-4 text-muted-foreground text-xs">
					正在准备本地任务存储…
				</p>
			)}
		</section>
	);
}
