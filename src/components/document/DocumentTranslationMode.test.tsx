/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { canStartDocumentRun, shouldDisableResume } from "./task-actions";

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
});
