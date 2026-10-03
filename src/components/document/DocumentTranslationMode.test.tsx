/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import type { DocumentTaskRecord } from "#/lib/document/model";
import {
	bindDocumentRunTask,
	canDeleteDocumentTask,
	canStartDocumentRun,
	hasResumableSource,
	reserveDocumentRun,
	shouldDisableDeleteDocumentTask,
	shouldDisableResume,
} from "./task-actions";

describe("document task controls", () => {
	it("disables resume while a task is active", () => {
		const reservation = reserveDocumentRun(undefined, new AbortController());
		expect(shouldDisableResume(reservation)).toBe(true);
		expect(shouldDisableResume(undefined)).toBe(false);
	});

	it("keeps a cancelled reservation until its run finally unwinds", () => {
		const controller = new AbortController();
		const reservation = reserveDocumentRun(undefined, controller, "first");

		expect(canStartDocumentRun(undefined)).toBe(true);
		expect(canStartDocumentRun(reservation)).toBe(false);

		controller.abort();
		expect(canStartDocumentRun(reservation)).toBe(false);
		expect(
			reserveDocumentRun(reservation, new AbortController(), "second"),
		).toBeUndefined();
	});

	it("rejects a second submit before it can save a task", () => {
		const first = reserveDocumentRun(undefined, new AbortController());
		const second = reserveDocumentRun(first, new AbortController());

		expect(first).toBeDefined();
		expect(second).toBeUndefined();
	});

	it("disables deletion for the task reserved during setup", () => {
		const entry = { id: "resuming", state: "failed" } as DocumentTaskRecord;
		const reservation = reserveDocumentRun(
			undefined,
			new AbortController(),
			"resuming",
		);

		expect(shouldDisableDeleteDocumentTask(entry, reservation)).toBe(true);
		expect(
			shouldDisableDeleteDocumentTask(
				entry,
				reservation === undefined
					? undefined
					: bindDocumentRunTask(reservation, "another"),
			),
		).toBe(false);
	});

	it("allows deleting interrupted tasks but protects the active run", () => {
		const interrupted = {
			id: "interrupted",
			state: "processing",
		} as DocumentTaskRecord;
		const active = { ...interrupted, id: "active" };

		expect(canDeleteDocumentTask(interrupted, undefined, false)).toBe(true);
		expect(canDeleteDocumentTask(interrupted, "active", true)).toBe(true);
		expect(canDeleteDocumentTask(active, "active", true)).toBe(false);
	});

	it("offers resume only when the source is still available", () => {
		const failed = {
			id: "failed",
			state: "failed",
		} as DocumentTaskRecord;
		const succeeded = { ...failed, state: "succeeded" } as DocumentTaskRecord;

		expect(hasResumableSource(failed, true)).toBe(true);
		expect(hasResumableSource(failed, false)).toBe(false);
		expect(hasResumableSource(succeeded, true)).toBe(false);
	});
});
