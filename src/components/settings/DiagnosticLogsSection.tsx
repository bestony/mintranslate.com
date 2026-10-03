/**
 * Diagnostic logs section on Settings page.
 *
 * Provides controls for:
 * - Starting a 5-minute diagnostic logging session
 * - Real-time countdown and active status badge
 * - Downloading recent 5-minute structured logs for AI Agent analysis
 * - Clearing local IndexedDB logs
 */

import { useCallback, useEffect, useState } from "react";
import { logger } from "#/lib/logger";
import {
	clearLogs,
	countLogs,
	downloadAgentLogsPayload,
	exportLogsForAgent,
	getDiagnosticSession,
	onDiagnosticSessionChange,
	openLogDatabase,
	startDiagnosticSession,
	stopDiagnosticSession,
} from "#/lib/logger/diagnostic";

const sectionClass = "island-shell mt-6 rounded-md p-6";
const buttonClass =
	"min-h-11 rounded-md bg-primary-strong px-4 text-primary-foreground text-sm disabled:opacity-50";
const ghostButtonClass =
	"min-h-11 rounded-md border border-border px-4 text-sm disabled:opacity-50";

function formatCountdown(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
	const mins = Math.floor(totalSeconds / 60);
	const secs = totalSeconds % 60;
	return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function DiagnosticLogsSection() {
	const [session, setSession] = useState(() => getDiagnosticSession());
	const [logCount, setLogCount] = useState<number>(0);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [isDownloading, setIsDownloading] = useState(false);

	const refreshLogCount = useCallback(async (_active?: boolean) => {
		try {
			const opened = await openLogDatabase();
			if (opened.ok) {
				const count = await countLogs(opened.db);
				setLogCount(count);
				opened.db.close();
			}
		} catch {
			// Ignore database count errors
		}
	}, []);

	useEffect(() => {
		void refreshLogCount(session.active);
	}, [refreshLogCount, session.active]);

	// Listen for session state changes (e.g. from other tabs or programmatic actions)
	useEffect(() => {
		const unsubscribe = onDiagnosticSessionChange((next) => {
			setSession(next);
		});
		return unsubscribe;
	}, []);

	// Active countdown ticker
	useEffect(() => {
		if (!session.active) return;

		const timer = setInterval(() => {
			const current = getDiagnosticSession();
			setSession(current);
			if (!current.active) {
				clearInterval(timer);
			}
		}, 1000);

		return () => clearInterval(timer);
	}, [session.active]);

	function handleStart() {
		const next = startDiagnosticSession();
		logger.info("diagnostic.session.start", {
			durationMs:
				next.startedAt !== undefined && next.expiresAt !== undefined
					? next.expiresAt - next.startedAt
					: 0,
		});
		setSession(next);
		setNotice("诊断日志已开启，将在 5 分钟后自动关闭。");
		void refreshLogCount();
	}

	function handleStop() {
		logger.info("diagnostic.session.stop");
		stopDiagnosticSession();
		setSession(getDiagnosticSession());
		setNotice("诊断日志已停止记录。");
		void refreshLogCount();
	}

	async function handleDownload() {
		setIsDownloading(true);
		setNotice(undefined);
		try {
			const payload = await exportLogsForAgent();
			const filename = downloadAgentLogsPayload(payload);
			logger.info("diagnostic.logs.download", {
				count: payload.summary.totalLogs,
			});
			setNotice(`已导出 ${payload.summary.totalLogs} 条日志至 ${filename}`);
			void refreshLogCount();
		} catch (error) {
			setNotice(
				`导出日志失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			setIsDownloading(false);
		}
	}

	async function handleClear() {
		try {
			const opened = await openLogDatabase();
			if (opened.ok) {
				await clearLogs(opened.db);
				opened.db.close();
				logger.info("diagnostic.logs.clear");
				setLogCount(0);
				setNotice("已清空本地存储的运行日志。");
			}
		} catch (error) {
			setNotice(
				`清空日志失败: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return (
		<section className={sectionClass} aria-labelledby="diagnostic-logs-title">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 id="diagnostic-logs-title" className="font-semibold text-xl">
					运行与诊断日志
				</h2>
				<div className="flex items-center gap-2">
					{session.active ? (
						<output
							className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-2 py-0 font-medium text-emerald-600 text-xs dark:bg-emerald-500/20 dark:text-emerald-400"
							aria-live="polite"
						>
							<span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
							记录中 · 剩余 {formatCountdown(session.remainingMs)}
						</output>
					) : (
						<output
							className="inline-flex items-center rounded-full bg-muted px-2 py-0 text-muted-foreground text-xs"
							aria-live="polite"
						>
							未开启
						</output>
					)}
					<span className="text-muted-foreground text-xs">
						已存储 {logCount} 条日志
					</span>
				</div>
			</div>

			<p className="mt-2 text-muted-foreground text-sm">
				开启后，系统将在接下来的 5 分钟内将运行日志与关键调试信息记录到浏览器的
				IndexedDB 中。5 分钟后会自动停止记录。你可以随时下载 5
				分钟内的结构化日志，方便排查问题或交由 Agent 分析。
			</p>

			<div className="mt-4 flex flex-wrap gap-4">
				{session.active ? (
					<button type="button" className={buttonClass} onClick={handleStop}>
						停止记录
					</button>
				) : (
					<button type="button" className={buttonClass} onClick={handleStart}>
						开启诊断日志 (5 分钟)
					</button>
				)}

				<button
					type="button"
					className={ghostButtonClass}
					onClick={handleDownload}
					disabled={logCount === 0 || isDownloading}
				>
					{isDownloading ? "正在导出…" : "下载最近 5 分钟日志"}
				</button>

				<button
					type="button"
					className={ghostButtonClass}
					onClick={handleClear}
					disabled={logCount === 0}
				>
					清空日志
				</button>
			</div>

			{notice && (
				<p className="mt-4 text-muted-foreground text-xs" role="alert">
					{notice}
				</p>
			)}

			<p className="mt-4 text-muted-foreground/80 text-xs">
				💡 导出的 JSON
				包含运行环境、脱敏的配置快照、日志级别分类汇总及详细事件流，所有 API Key
				及私密凭据已预先脱敏，可直接交由 AI Agent 进行分析。
			</p>
		</section>
	);
}
