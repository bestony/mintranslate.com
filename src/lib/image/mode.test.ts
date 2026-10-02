/**
 * Mode value contract.
 *
 * Two failure modes matter: an unrecognised value must not leave the workspace
 * unable to render, and the image value must be the one the analytics contract
 * already knows, or image runs would be attributed to text.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import { ANALYTICS_MODES } from "#/lib/analytics/events";
import {
	MODE_URL_VALUES,
	modeFromUrl,
	urlValueForMode,
	WORKSPACE_MODES,
} from "./mode";

describe("resolving the URL value", () => {
	it("selects image mode for the image value", () => {
		expect(modeFromUrl("images")).toBe("images");
	});

	it("falls back to text for the legacy value", () => {
		// The workspace wrote `translate` before this change; such links must keep
		// working rather than landing on an unknown mode.
		expect(modeFromUrl("translate")).toBe("text");
	});

	it("falls back to text for anything unrecognised", () => {
		for (const value of ["", undefined, "docs", "websites", "IMAGE", "image"]) {
			expect(modeFromUrl(value), JSON.stringify(value)).toBe("text");
		}
	});
});

describe("the image value is one analytics already knows", () => {
	it("appears in the analytics mode set", () => {
		// This is what lets an image run be attributed to images without touching the
		// event contract.
		expect(ANALYTICS_MODES as readonly string[]).toContain(
			MODE_URL_VALUES.images,
		);
	});
});

describe("round trip", () => {
	it("resolves every mode from its own URL value", () => {
		for (const mode of WORKSPACE_MODES) {
			expect(modeFromUrl(urlValueForMode(mode))).toBe(mode);
		}
	});
});
