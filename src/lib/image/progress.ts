/**
 * Progress state for an image translation.
 *
 * The 30-second notice is a UI obligation with a testable core, so the decision is
 * a pure function of elapsed time and stage. Keeping it out of the component means
 * the threshold can be tested with a fake clock instead of a rendered timer.
 */

/** Where a run currently is. */
export const IMAGE_STAGES = [
	/** Nothing submitted. */
	"idle",
	/** Validating and preprocessing. */
	"preparing",
	/** Waiting for the model. */
	"analyzing",
	/** Finished, with a result to show. */
	"done",
	/** Finished, without a result. */
	"failed",
] as const;

export type ImageStage = (typeof IMAGE_STAGES)[number];

/** After this long on one image, the user is offered a choice. */
export const SLOW_RUN_THRESHOLD_MS = 30_000;

/** What the interface should show. */
export interface ProgressView {
	/** Whether work is in progress. */
	readonly busy: boolean;
	/** Label for the current stage. */
	readonly label: string;
	/** True once the run has been slow enough to warrant the notice. */
	readonly slow: boolean;
	/** Whether a cancel control applies. */
	readonly cancellable: boolean;
}

/** Labels per stage, kept here so the component holds no copy. */
const LABELS: Record<ImageStage, string> = {
	idle: "等待选择图片",
	preparing: "正在处理图片…",
	analyzing: "正在识别并翻译…",
	done: "已完成",
	failed: "未能完成",
};

/** Whether work is in flight for this stage. */
export function isBusy(stage: ImageStage): boolean {
	return stage === "preparing" || stage === "analyzing";
}

/**
 * Describe the current run.
 *
 * `elapsedMs` is only meaningful while busy; a finished run is never "slow", so a
 * stale timer cannot leave the notice on screen after completion.
 */
export function progressView(
	stage: ImageStage,
	elapsedMs: number,
): ProgressView {
	const busy = isBusy(stage);

	return {
		busy,
		label: LABELS[stage],
		slow: busy && elapsedMs >= SLOW_RUN_THRESHOLD_MS,
		cancellable: busy,
	};
}

/** What the user chose when the slow notice appeared. */
export type SlowRunChoice = "wait" | "cancel";

/**
 * Whether a cancel should still be accepted.
 *
 * Once the run has finished, a cancel control must not remain actionable — it
 * would abort whichever run starts next.
 */
export function acceptsCancel(stage: ImageStage): boolean {
	return isBusy(stage);
}
