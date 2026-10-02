/**
 * Feedback panel.
 *
 * Three verdict levels plus an editable suggestion. The suggestion edits a copy of
 * the translation — it never replaces the on-screen result or the stored history
 * entry, because a suggestion is an opinion about the translation, not a new one.
 *
 * Feedback lives in its own local database (see `src/lib/feedback`), so nothing
 * here contacts the network.
 *
 * The caller keys this component by the translation, which is what resets the
 * editable suggestion when a new result arrives. Resetting from an effect keyed
 * on a prop would be the "derive state from props" anti-pattern; keying is the
 * React-native way to express "this is a different panel now".
 */

import { useCallback, useRef, useState } from "react";

import {
	DEFAULT_FEEDBACK_LIMIT,
	exportFeedback,
	type FeedbackKind,
	openFeedbackDatabase,
	recordFeedback,
} from "#/lib/feedback";
import { logger } from "#/lib/logger";

interface FeedbackPanelProps {
	readonly sourceText: string;
	readonly targetText: string;
	readonly sourceLang: string;
	readonly targetLang: string;
}

export function FeedbackPanel({
	sourceText,
	targetText,
	sourceLang,
	targetLang,
}: FeedbackPanelProps) {
	const [open, setOpen] = useState(false);
	const [editingSuggestion, setEditingSuggestion] = useState(false);
	const [suggestion, setSuggestion] = useState("");
	const [message, setMessage] = useState<string | undefined>(undefined);
	const [unavailableReason, setUnavailableReason] = useState<
		string | undefined
	>(undefined);

	/**
	 * The feedback database, opened on first use.
	 *
	 * Held as a promise so concurrent actions share a single open, and created
	 * lazily so a browser without IndexedDB never blocks the panel from rendering.
	 */
	const dbRef = useRef<Promise<IDBDatabase | null> | undefined>(undefined);

	const getDb = useCallback(async (): Promise<IDBDatabase | null> => {
		if (dbRef.current === undefined) {
			dbRef.current = openFeedbackDatabase().then((result) => {
				if (!result.ok) {
					logger.warn("feedback.open.failed", { reason: result.reason });
					setUnavailableReason(result.reason);
					return null;
				}
				return result.db;
			});
		}
		return dbRef.current;
	}, []);

	async function submit(kind: FeedbackKind, suggestionText?: string) {
		const db = await getDb();
		if (!db) return;

		const result = await recordFeedback(db, {
			kind,
			targetText,
			sourceText,
			sourceLang,
			targetLang,
			...(suggestionText !== undefined && { suggestion: suggestionText }),
		});

		if (!result.ok) {
			setMessage(result.reason);
			return;
		}

		setMessage(
			kind === "suggestion"
				? "修改建议已记录（仅保存在本地）。"
				: "感谢反馈（仅保存在本地）。",
		);
		setEditingSuggestion(false);
	}

	async function exportAll() {
		const db = await getDb();
		if (!db) return;

		const outcome = await exportFeedback(db);
		if (!outcome.ok) {
			setMessage(outcome.reason);
			return;
		}

		const blob = new Blob([outcome.payload], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "mintranslate-feedback.json";
		anchor.click();
		URL.revokeObjectURL(url);

		setMessage(`已导出 ${outcome.count} 条反馈。`);
	}

	if (targetText.trim() === "") return null;

	if (unavailableReason !== undefined) {
		return (
			<p className="text-muted-foreground text-xs">
				当前环境无法保存反馈：{unavailableReason}。翻译功能不受影响。
			</p>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-3">
			<button
				type="button"
				className="nav-link text-xs"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				翻译质量
			</button>

			{open && (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface/60 px-2 py-1">
					<button
						type="button"
						className="nav-link text-xs"
						onClick={() => void submit("good")}
					>
						质量很好
					</button>
					<button
						type="button"
						className="nav-link text-xs"
						onClick={() => void submit("bad")}
					>
						翻译质量很差
					</button>
					<button
						type="button"
						className="nav-link text-xs"
						aria-pressed={editingSuggestion}
						onClick={() => {
							setEditingSuggestion(true);
							// Seed with the current translation: the common edit is a small
							// correction, not a rewrite from scratch.
							setSuggestion((current) =>
								current === "" ? targetText : current,
							);
						}}
					>
						提出修改建议
					</button>
					<button
						type="button"
						className="nav-link text-xs"
						onClick={() => void exportAll()}
					>
						导出反馈
					</button>
				</div>
			)}

			{editingSuggestion && (
				<div className="w-full">
					<textarea
						className="mt-2 h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						aria-label="修改建议"
						value={suggestion}
						onChange={(event) => setSuggestion(event.target.value)}
					/>
					<div className="mt-1 flex items-center gap-3">
						<button
							type="button"
							className="nav-link text-xs disabled:opacity-40"
							disabled={suggestion.trim() === ""}
							onClick={() => void submit("suggestion", suggestion)}
						>
							提交建议
						</button>
						<button
							type="button"
							className="nav-link text-xs"
							onClick={() => setEditingSuggestion(false)}
						>
							取消
						</button>
						<span className="text-muted-foreground text-xs">
							建议只保存在本地，不会替换当前译文。
						</span>
					</div>
				</div>
			)}

			{message !== undefined && (
				<span className="text-muted-foreground text-xs">{message}</span>
			)}

			<span className="text-muted-foreground text-xs">
				反馈仅存本地，最多保留 {DEFAULT_FEEDBACK_LIMIT} 条。
			</span>
		</div>
	);
}
