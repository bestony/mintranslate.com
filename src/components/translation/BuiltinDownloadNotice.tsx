import type { BuiltinDownloadState } from "#/lib/builtin-ai/download";
import { languageName } from "#/lib/languages";

/** Explicit user activation and progress for the model needed by this request. */
export function BuiltinDownloadNotice({
	state,
	onActivate,
}: {
	readonly state: BuiltinDownloadState;
	readonly onActivate: () => void;
}) {
	const request = state.request;
	if (
		request === undefined ||
		state.phase === "idle" ||
		state.phase === "complete"
	)
		return null;
	const downloading = state.phase === "downloading";
	const label =
		request.provider === "builtin-translator"
			? `内置翻译模型：${languageName(request.sourceLanguage ?? "")} → ${languageName(request.targetLanguage)}`
			: `内置多模态模型：${languageName(request.targetLanguage)}`;
	return (
		<div className="mt-4 rounded-md border border-border bg-surface p-4 text-sm">
			<p className="font-medium">{label}</p>
			<p className="mt-2 text-muted-foreground text-xs" aria-live="polite">
				{state.phase === "failed"
					? state.error
					: downloading
						? `下载中 · ${Math.round((state.progress ?? 0) * 100)}%`
						: request.availability === "downloading"
							? "模型正在下载，点击后连接进度并继续本次翻译。"
							: "本次翻译需要下载模型，完成后会自动继续翻译。"}
			</p>
			{downloading && (
				<progress
					className="mt-2 w-full accent-primary-strong"
					aria-label="模型下载进度"
					value={state.progress ?? 0}
					max={1}
				/>
			)}
			<button
				type="button"
				name="builtin-model-download"
				className="mt-2 min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs disabled:opacity-50"
				disabled={downloading}
				onClick={onActivate}
			>
				{downloading
					? "下载中…"
					: state.phase === "failed"
						? "重试下载"
						: "下载并继续翻译"}
			</button>
		</div>
	);
}
