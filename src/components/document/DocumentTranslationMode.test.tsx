/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import type { DocumentTaskRecord } from "#/lib/document/model";
import {
	canDeleteDocumentTask,
	canStartDocumentRun,
	shouldDisableResume,
} from "./task-actions";

describe("document task controls", () => {
	it("disables resume while a task is active", () => {
		expect(shouldDisableResume(true)).toBe(true);
		expect(shouldDisableResume(false)).toBe(false);
	});

	it("guards a second run while the current controller is active", () => {
		const controller = new AbortController();

		expect(canStartDocumentRun(undefined)).toBe(true);
		expect(canStartDocumentRun(controller)).toBe(false);

		controller.abort();
		expect(canStartDocumentRun(controller)).toBe(true);
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
});
