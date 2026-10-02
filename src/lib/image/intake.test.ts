/**
 * Intake decisions.
 *
 * The three entry points normalise into the same shape here, so the component has
 * no decisions of its own. The cases that matter are the ones a real user hits:
 * pasting text instead of an image, dropping a folder or a PDF, and dropping
 * something the target must visibly refuse.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import {
	candidatesFromFiles,
	clipboardHasImage,
	dragLooksAcceptable,
	dropStateView,
	imageFromClipboard,
} from "./intake";

const png = { name: "a.png", type: "image/png", size: 100 };

describe("file lists", () => {
	it("returns the candidates in order", () => {
		const result = candidatesFromFiles([
			png,
			{ name: "b.jpg", type: "image/jpeg", size: 200 },
		]);
		expect(result.candidates.map((c) => c.name)).toEqual(["a.png", "b.jpg"]);
		expect(result.empty).toBe(false);
	});

	it("reports an empty selection rather than throwing", () => {
		expect(candidatesFromFiles([])).toEqual({ candidates: [], empty: true });
		expect(candidatesFromFiles(undefined).empty).toBe(true);
	});
});

describe("clipboard", () => {
	it("takes the image out of a file item", () => {
		const found = imageFromClipboard([
			{ kind: "file", type: "image/png", getAsFile: () => png },
		]);
		expect(found).toBe(png);
	});

	it("ignores a text-only paste", () => {
		// Pasting text must not start an image translation.
		const items = [
			{ kind: "string", type: "text/plain" },
			{ kind: "string", type: "text/html" },
		];
		expect(imageFromClipboard(items)).toBeUndefined();
		expect(clipboardHasImage(items)).toBe(false);
	});

	it("prefers the image when a paste carries text and an image", () => {
		const items = [
			{ kind: "string", type: "text/plain" },
			{ kind: "file", type: "image/png", getAsFile: () => png },
		];
		expect(imageFromClipboard(items)).toBe(png);
	});

	it("ignores a non-image file item", () => {
		const items = [
			{
				kind: "file",
				type: "application/pdf",
				getAsFile: () => ({ name: "d.pdf", type: "application/pdf", size: 10 }),
			},
		];
		expect(imageFromClipboard(items)).toBeUndefined();
	});

	it("handles an item that yields no file", () => {
		expect(
			imageFromClipboard([
				{ kind: "file", type: "image/png", getAsFile: () => null },
			]),
		).toBeUndefined();
	});

	it("handles a missing item list", () => {
		expect(imageFromClipboard(undefined)).toBeUndefined();
		expect(clipboardHasImage(undefined)).toBe(false);
	});
});

describe("drop target states", () => {
	it("is idle when nothing is being dragged", () => {
		expect(dropStateView(false, true).state).toBe("idle");
	});

	it("is active for an acceptable drag", () => {
		expect(dropStateView(true, false).state).toBe("active");
	});

	it("is invalid for an unacceptable drag", () => {
		expect(dropStateView(true, true).state).toBe("invalid");
	});

	it("gives each state its own message", () => {
		const idle = dropStateView(false, false).message;
		const active = dropStateView(true, false).message;
		const invalid = dropStateView(true, true).message;

		// Distinct text is what makes the states distinguishable without colour.
		expect(new Set([idle, active, invalid]).size).toBe(3);
		expect(active).not.toBe(invalid);
	});

	it("names the accepted formats in the invalid message", () => {
		expect(dropStateView(true, true).message).toContain("webp");
	});
});

describe("dragover hint", () => {
	it("accepts the Files type", () => {
		expect(dragLooksAcceptable(["Files"])).toBe(true);
	});

	it("rejects other drag payloads", () => {
		expect(dragLooksAcceptable(["text/plain"])).toBe(false);
		expect(dragLooksAcceptable([])).toBe(false);
		expect(dragLooksAcceptable(undefined)).toBe(false);
	});
});
