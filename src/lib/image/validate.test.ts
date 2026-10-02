/**
 * Image acceptance rules.
 *
 * The decision table is small but has real edge cases: an empty MIME type is
 * normal (a system that did not recognise the extension), a wrong MIME type is a
 * definitive rejection, and format must be judged before size so the message names
 * the more fundamental problem.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import { MAX_IMAGE_BYTES } from "./model";
import { describeBytes, validateImageCandidate } from "./validate";

const LIMIT = MAX_IMAGE_BYTES;

describe("accepted formats", () => {
	it("accepts the four listed formats", () => {
		for (const [name, type] of [
			["photo.jpg", "image/jpeg"],
			["photo.jpeg", "image/jpeg"],
			["score.png", "image/png"],
			["shot.webp", "image/webp"],
		]) {
			expect(
				validateImageCandidate({ name, type, size: 1024 }),
				`${name} should be accepted`,
			).toEqual({ ok: true });
		}
	});

	it("rejects other formats and names what it accepts", () => {
		for (const [name, type] of [
			["anim.gif", "image/gif"],
			["doc.pdf", "application/pdf"],
			["vector.svg", "image/svg+xml"],
			["archive.zip", "application/zip"],
		]) {
			const result = validateImageCandidate({ name, type, size: 1024 });
			expect(result.ok, `${name} should be rejected`).toBe(false);
			if (result.ok) continue;
			expect(result.reason).toContain("jpg");
			expect(result.reason).toContain("webp");
		}
	});

	it("falls back to the extension when the MIME type is empty", () => {
		// Some systems report no type for a perfectly valid file; rejecting those
		// would fail the user for their file manager's behaviour.
		expect(
			validateImageCandidate({ name: "IMG_1234.JPG", type: "", size: 2048 }),
		).toEqual({ ok: true });
		expect(
			validateImageCandidate({ name: "noext", type: "", size: 2048 }).ok,
		).toBe(false);
	});

	it("does not accept a file whose MIME type contradicts its extension", () => {
		// `image/gif` is a definitive statement about the content, so the extension
		// must not override it.
		expect(
			validateImageCandidate({
				name: "trick.jpg",
				type: "image/gif",
				size: 100,
			}).ok,
		).toBe(false);
	});
});

describe("size limit", () => {
	it("accepts exactly the limit", () => {
		expect(
			validateImageCandidate({ name: "a.png", type: "image/png", size: LIMIT }),
		).toEqual({ ok: true });
	});

	it("rejects one byte over, naming both numbers", () => {
		const result = validateImageCandidate({
			name: "a.png",
			type: "image/png",
			size: LIMIT + 1,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// The user needs to know how far over they are, not just that they are over.
		expect(result.reason).toContain("10.0 MB");
		expect(result.reason).toContain("上限");
	});

	it("rejects an empty file as unreadable", () => {
		expect(
			validateImageCandidate({ name: "a.png", type: "image/png", size: 0 }).ok,
		).toBe(false);
	});

	it("reports format before size when both fail", () => {
		// Saying "your GIF is too large" would mislead: shrinking it would not help.
		const result = validateImageCandidate({
			name: "big.gif",
			type: "image/gif",
			size: LIMIT * 2,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("格式");
	});
});

describe("message helpers", () => {
	it("formats bytes at each scale", () => {
		expect(describeBytes(512)).toBe("512 B");
		expect(describeBytes(2048)).toBe("2 KB");
		expect(describeBytes(MAX_IMAGE_BYTES)).toBe("10.0 MB");
	});
});
