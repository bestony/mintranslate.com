/**
 * Progress and the 30-second notice.
 *
 * The threshold is the interesting part: it must appear while waiting, must not
 * appear for a run that finished before it, and must clear once the run ends so a
 * stale timer cannot leave the notice on screen.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import {
	acceptsCancel,
	IMAGE_STAGES,
	isBusy,
	progressView,
	SLOW_RUN_THRESHOLD_MS,
} from "./progress";

describe("busy stages", () => {
	it("treats preparing and analyzing as busy", () => {
		expect(isBusy("preparing")).toBe(true);
		expect(isBusy("analyzing")).toBe(true);
	});

	it("treats the resting stages as not busy", () => {
		for (const stage of ["idle", "done", "failed"] as const) {
			expect(isBusy(stage)).toBe(false);
		}
	});

	it("labels every stage", () => {
		for (const stage of IMAGE_STAGES) {
			expect(progressView(stage, 0).label.length).toBeGreaterThan(0);
		}
	});
});

describe("the 30 second notice", () => {
	it("does not appear just under the threshold", () => {
		expect(progressView("analyzing", SLOW_RUN_THRESHOLD_MS - 1).slow).toBe(
			false,
		);
	});

	it("appears at the threshold", () => {
		expect(progressView("analyzing", SLOW_RUN_THRESHOLD_MS).slow).toBe(true);
	});

	it("appears for a slow preparation too", () => {
		// A 10MB image on a slow device can be slow before any request is made.
		expect(progressView("preparing", SLOW_RUN_THRESHOLD_MS + 1).slow).toBe(
			true,
		);
	});

	it("never appears once the run has ended", () => {
		// A timer that fires after completion must not leave the notice on screen.
		expect(progressView("done", SLOW_RUN_THRESHOLD_MS * 10).slow).toBe(false);
		expect(progressView("failed", SLOW_RUN_THRESHOLD_MS * 10).slow).toBe(false);
	});

	it("does not appear while idle", () => {
		expect(progressView("idle", SLOW_RUN_THRESHOLD_MS * 10).slow).toBe(false);
	});
});

describe("cancel availability", () => {
	it("is available while busy", () => {
		expect(acceptsCancel("preparing")).toBe(true);
		expect(acceptsCancel("analyzing")).toBe(true);
	});

	it("is not available after the run ends", () => {
		// A leftover control would cancel the *next* run.
		expect(acceptsCancel("done")).toBe(false);
		expect(acceptsCancel("failed")).toBe(false);
		expect(acceptsCancel("idle")).toBe(false);
	});

	it("matches the cancellable flag in the view", () => {
		for (const stage of IMAGE_STAGES) {
			expect(progressView(stage, 0).cancellable).toBe(acceptsCancel(stage));
		}
	});
});
