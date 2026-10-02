/**
 * Image translation result view.
 *
 * Three views over the same data, plus a region list and an overlay that stay in
 * step with each other. Two rules shape the implementation:
 *
 * - **The views are presentation only.** Switching never re-requests and never
 *   changes the regions; a sort may reorder them but cannot drop one.
 * - **Uncertainty is stated, not tinted.** An uncertain region gets a dashed edge
 *   and the word "不确定" in its row, because a colour difference alone would be
 *   invisible to some users and meaningless to a screen reader.
 */

import { useMemo, useState } from "react";

import type { ImageRegion } from "#/lib/image";
import { RegionOverlay } from "./RegionOverlay";

/** The three views. */
export const RESULT_VIEWS = [
	"original",
	"translation",
	"side-by-side",
] as const;
export type ResultView = (typeof RESULT_VIEWS)[number];

const VIEW_LABELS: Record<ResultView, string> = {
	original: "原文",
	translation: "译文",
	"side-by-side": "对照",
};

interface ImageResultViewProps {
	readonly regions: readonly ImageRegion[];
	/** Processed image source, i.e. what the model actually saw. */
	readonly imageSrc: string;
	readonly imageAlt: string;
	/**
	 * Raw model text, set only when structured parsing failed twice.
	 *
	 * Shown instead of an empty region list so the user sees what came back.
	 */
	readonly rawText?: string;
	/** Natural width of the processed image, so it is never upscaled. */
	readonly naturalWidth?: number;
}

/** One region's text, per view. */
function regionText(region: ImageRegion, view: ResultView): string {
	if (view === "original") return region.source;
	if (view === "translation") return region.target;
	return `${region.source} → ${region.target}`;
}

export function ImageResultView({
	regions,
	imageSrc,
	imageAlt,
	rawText,
	naturalWidth,
}: ImageResultViewProps) {
	const [view, setView] = useState<ResultView>("side-by-side");
	const [activeId, setActiveId] = useState<string | undefined>(undefined);

	// Ordering is presentation: it never removes an entry, so every region stays
	// reachable whichever view is selected.
	const orderedRegions = useMemo(
		() =>
			[...regions].sort((a, b) => {
				const top = (a.box?.y ?? 1) - (b.box?.y ?? 1);
				if (top !== 0) return top;
				return (a.box?.x ?? 0) - (b.box?.x ?? 0);
			}),
		[regions],
	);

	if (rawText !== undefined) {
		return (
			<div className="mt-4">
				<p
					className="rounded-md border border-border bg-surface p-4 text-sm"
					role="alert"
				>
					模型返回的内容无法按结构解析（已重试一次）。以下为原始返回文本，可能不是完整结果。
				</p>
				<pre className="mt-4 whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-4 font-mono text-sm">
					{rawText}
				</pre>
			</div>
		);
	}

	if (regions.length === 0) {
		return (
			<div className="mt-4">
				<p className="rounded-md border border-border bg-surface p-4 text-sm">
					未在图片中识别到文字。可以换一张更清晰或文字更大的图片重试。
				</p>
				<div className="mt-4">
					<RegionOverlay
						regions={regions}
						onActivate={setActiveId}
						imageAlt={imageAlt}
						imageSrc={imageSrc}
						naturalWidth={naturalWidth}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="mt-4">
			{/* View switch. `aria-pressed` on a group of buttons rather than a radio
			    group, because switching does not submit anything. */}
			<div
				className="flex flex-wrap items-center gap-2"
				role="toolbar"
				aria-label="结果视图"
			>
				{RESULT_VIEWS.map((candidate) => (
					<button
						key={candidate}
						type="button"
						aria-pressed={view === candidate}
						className={
							view === candidate
								? "min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
								: "min-h-11 rounded-sm border border-border px-4 text-xs"
						}
						onClick={() => setView(candidate)}
					>
						{VIEW_LABELS[candidate]}
					</button>
				))}
				<span className="text-muted-foreground text-xs">
					当前视图：{VIEW_LABELS[view]}
				</span>
			</div>

			<div className="mt-4">
				<RegionOverlay
					regions={orderedRegions}
					activeId={activeId}
					onActivate={setActiveId}
					imageAlt={imageAlt}
					imageSrc={imageSrc}
					naturalWidth={naturalWidth}
				/>
			</div>

			<ol className="mt-4 space-y-2" aria-label="识别到的文字区域">
				{orderedRegions.map((region) => (
					<li key={region.id}>
						<button
							// A real button, so the keyboard can walk the list and drive the
							// overlay link in both directions without a synthetic role.
							type="button"
							data-region-id={region.id}
							aria-current={activeId === region.id ? "true" : undefined}
							className={[
								"block min-h-11 w-full rounded-sm border p-2 text-left text-sm",
								activeId === region.id
									? "border-primary-strong bg-surface"
									: "border-border",
							].join(" ")}
							onFocus={() => setActiveId(region.id)}
							onMouseEnter={() => setActiveId(region.id)}
							onClick={() => setActiveId(region.id)}
						>
							<p>{regionText(region, view)}</p>
							<p className="mt-2 text-muted-foreground text-xs">
								{region.box === undefined && "未定位"}
								{region.box === undefined && region.uncertain && " · "}
								{region.uncertain && "识别不确定"}
							</p>
						</button>
					</li>
				))}
			</ol>
		</div>
	);
}
