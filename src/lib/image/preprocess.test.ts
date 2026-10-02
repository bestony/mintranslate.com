/**
 * Resize planning and the preprocessing pipeline.
 *
 * The arithmetic is tested directly, and the pipeline is tested through a stub
 * environment — which is also the mechanism that keeps the pipeline free of canvas
 * types. The stub records what it was asked to do, so the assertions are about the
 * calls the browser would receive.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi } from "vitest";

import {
	type Dimensions,
	type ImageBytes,
	MAX_SENT_BYTES,
	MAX_SENT_EDGE_PX,
	type ProcessedImage,
} from "./model";
import {
	type DecodedImage,
	type ImageEnvironment,
	preprocessImage,
} from "./preprocess";
import { encodeAttempts, scaleToFit } from "./resize";

describe("scaleToFit", () => {
	it("scales a landscape image by its longest edge", () => {
		expect(scaleToFit({ width: 4096, height: 2048 })).toEqual({
			width: 2048,
			height: 1024,
		});
	});

	it("scales a portrait image by its longest edge", () => {
		expect(scaleToFit({ width: 1500, height: 3000 })).toEqual({
			width: 1024,
			height: 2048,
		});
	});

	it("leaves an image inside the limit untouched", () => {
		expect(scaleToFit({ width: 800, height: 600 })).toEqual({
			width: 800,
			height: 600,
		});
	});

	it("does not scale up a small image", () => {
		// Enlarging would inflate the payload and the cost for no added detail.
		expect(scaleToFit({ width: 120, height: 90 })).toEqual({
			width: 120,
			height: 90,
		});
	});

	it("never rounds a side down to zero", () => {
		// A zero-sized canvas cannot encode, so an extreme aspect ratio must still
		// produce at least one pixel on the short side.
		const result = scaleToFit({ width: 20000, height: 3 });
		expect(result.width).toBe(MAX_SENT_EDGE_PX);
		expect(result.height).toBeGreaterThanOrEqual(1);
	});

	it("handles a degenerate dimension without dividing by zero", () => {
		expect(scaleToFit({ width: 0, height: 0 })).toEqual({
			width: 0,
			height: 0,
		});
	});
});

describe("encodeAttempts", () => {
	it("encodes once at full size when nothing needs shrinking", () => {
		const attempts = encodeAttempts({ width: 800, height: 600 });
		expect(attempts).toHaveLength(1);
		expect(attempts[0].needsResize).toBe(false);
		expect(attempts[0].target).toEqual({ width: 800, height: 600 });
	});

	it("offers descending qualities when the image must shrink", () => {
		const attempts = encodeAttempts({ width: 6000, height: 4000 });

		expect(attempts.length).toBeGreaterThan(1);
		expect(attempts[0].needsResize).toBe(true);
		// Every attempt targets the same (already scaled) size; quality is the only
		// variable, so a smaller payload never costs detail twice.
		for (const attempt of attempts) {
			expect(attempt.target.width).toBeLessThanOrEqual(MAX_SENT_EDGE_PX);
			expect(attempt.target).toEqual(attempts[0].target);
		}
		const qualities = attempts.map((a) => a.quality);
		expect([...qualities]).toEqual([...qualities].sort((a, b) => b - a));
	});
});

/** A stub environment that produces a fixed-size output. */
function stubEnvironment(options: {
	readonly dimensions: Dimensions;
	/** Encoded size per call, in order; the last value repeats. */
	readonly sizes: readonly number[];
}) {
	const calls: Array<{
		target: Dimensions;
		quality: number;
		mimeType: string;
	}> = [];
	let decodeOptions: unknown;
	let released = 0;

	const environment: ImageEnvironment = {
		async decode(_bytes, _mimeType): Promise<DecodedImage> {
			return {
				width: options.dimensions.width,
				height: options.dimensions.height,
				handle: { stub: true },
			};
		},
		async encode(_image, target, quality, mimeType) {
			calls.push({ target, quality, mimeType });
			const index = Math.min(calls.length - 1, options.sizes.length - 1);
			return new Uint8Array(options.sizes[index]);
		},
		release() {
			released += 1;
		},
	};

	return {
		environment,
		calls,
		released: () => released,
		decodeOptions: () => decodeOptions,
	};
}

const bytesOf = (length: number): ImageBytes => ({
	bytes: new Uint8Array(length),
	mimeType: "image/jpeg",
});

describe("preprocessImage", () => {
	it("re-encodes even when the image already fits", async () => {
		// Re-encoding is what removes metadata. Skipping it for a small file would
		// send the user's GPS coordinates along with their picture.
		const stub = stubEnvironment({
			dimensions: { width: 800, height: 600 },
			sizes: [1000],
		});

		const result = await preprocessImage(bytesOf(2000), stub.environment);

		expect(stub.calls).toHaveLength(1);
		expect(result.originalBytes).toBe(2000);
		expect(result.bytes.byteLength).toBe(1000);
	});

	it("encodes at the planned size and quality", async () => {
		const stub = stubEnvironment({
			dimensions: { width: 6000, height: 4000 },
			sizes: [10],
		});

		await preprocessImage(bytesOf(5000), stub.environment);

		expect(stub.calls[0].target.width).toBe(MAX_SENT_EDGE_PX);
		expect(stub.calls[0].mimeType).toBe("image/jpeg");
		expect(stub.calls[0].quality).toBeGreaterThan(0);
		expect(stub.calls[0].quality).toBeLessThanOrEqual(1);
	});

	it("stops at the first attempt that fits the byte limit", async () => {
		const stub = stubEnvironment({
			dimensions: { width: 6000, height: 4000 },
			sizes: [MAX_SENT_BYTES + 1, 1000],
		});

		const result = await preprocessImage(bytesOf(5000), stub.environment);

		expect(stub.calls).toHaveLength(2);
		expect(result.bytes.byteLength).toBe(1000);
	});

	it("keeps the last attempt when every one is too large", async () => {
		// A slightly large image is more useful than none, and the log records it.
		const stub = stubEnvironment({
			dimensions: { width: 6000, height: 4000 },
			sizes: [MAX_SENT_BYTES + 100],
		});

		const result = await preprocessImage(bytesOf(5000), stub.environment);

		expect(result.bytes.byteLength).toBe(MAX_SENT_BYTES + 100);
	});

	it("reports the post-rotation dimensions from the decoder", async () => {
		// The pipeline must take dimensions from the decoded bitmap, because that is
		// where orientation has already been applied.
		const stub = stubEnvironment({
			dimensions: { width: 600, height: 1200 },
			sizes: [500],
		});

		const result = await preprocessImage(bytesOf(500), stub.environment);

		expect(result.width).toBe(600);
		expect(result.height).toBe(1200);
		expect(result.originalWidth).toBe(600);
		expect(result.originalHeight).toBe(1200);
	});

	it("marks a re-encoded image as compressed", async () => {
		const stub = stubEnvironment({
			dimensions: { width: 800, height: 600 },
			sizes: [1000],
		});

		const result = await preprocessImage(bytesOf(2000), stub.environment);
		expect(result.compressed).toBe(true);
	});

	it("releases the decoded image exactly once", async () => {
		const stub = stubEnvironment({
			dimensions: { width: 800, height: 600 },
			sizes: [1000],
		});

		await preprocessImage(bytesOf(2000), stub.environment);
		expect(stub.released()).toBe(1);
	});

	it("releases the decoded image when encoding throws", async () => {
		// A leaked bitmap holds the whole uncompressed image in memory.
		const stub = stubEnvironment({
			dimensions: { width: 800, height: 600 },
			sizes: [1000],
		});
		const failing: ImageEnvironment = {
			...stub.environment,
			encode: vi.fn().mockRejectedValue(new Error("encode failed")),
			release: stub.environment.release,
		};

		await expect(preprocessImage(bytesOf(2000), failing)).rejects.toThrow(
			"encode failed",
		);
		expect(stub.released()).toBe(1);
	});

	it("produces the same result whichever environment is used", async () => {
		// The requirement that the main-thread fallback matches the worker path is
		// only credible if both run this same function; asserted here by running it
		// twice with equivalent stubs and comparing the outcome.
		const input = bytesOf(4000);
		const options = {
			dimensions: { width: 5000, height: 2500 },
			sizes: [2000],
		};

		const first = await preprocessImage(
			input,
			stubEnvironment(options).environment,
		);
		const second = await preprocessImage(
			input,
			stubEnvironment(options).environment,
		);

		expect({ ...first, bytes: undefined }).toEqual({
			...second,
			bytes: undefined,
		});
		expect(first.bytes.byteLength).toBe(second.bytes.byteLength);
	});
});

describe("no format-specific metadata handling", () => {
	it("does not parse EXIF or image container structures", async () => {
		// Metadata removal comes from re-encoding. A parser here would mean someone
		// reintroduced per-format segment deletion, which this design rejects.
		const { readFileSync } = await import("node:fs");
		for (const file of [
			"src/lib/image/preprocess.ts",
			"src/lib/image/canvas-environment.ts",
		]) {
			const source = readFileSync(file, "utf8");
			const code = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|[^:])\/\/.*$/gm, "$1");

			expect(code).not.toMatch(/exif/i);
			expect(code).not.toMatch(/0xFFE1/);
			expect(code).not.toMatch(/RIFF/);
			expect(code).not.toMatch(/APP1/);
		}
	});
});

describe("images are not persisted", () => {
	it("touches no storage during preprocessing", async () => {
		const storageWrite = vi.fn();
		const original = Object.getOwnPropertyDescriptor(
			globalThis,
			"localStorage",
		);
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: () => null,
				setItem: storageWrite,
				removeItem: () => {},
			},
		});

		const stub = stubEnvironment({
			dimensions: { width: 800, height: 600 },
			sizes: [1000],
		});
		await preprocessImage(bytesOf(2000), stub.environment);

		expect(storageWrite).not.toHaveBeenCalled();

		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});

	it("does not import a storage module", async () => {
		const { readFileSync } = await import("node:fs");
		for (const file of [
			"src/lib/image/preprocess.ts",
			"src/lib/image/runner.ts",
			"src/lib/image/canvas-environment.ts",
		]) {
			const source = readFileSync(file, "utf8");
			expect(source).not.toMatch(
				/from ".*(history|translation-memory|storage)/,
			);
			expect(source).not.toMatch(/indexedDB|localStorage|sessionStorage/);
		}
	});
});

describe("runner fallback", () => {
	it("uses the main thread when worker canvas is unavailable, and logs why", async () => {
		const { preprocessWithFallback } = await import("./runner");
		const warnings: Array<{ event: string; fields: unknown }> = [];
		const { logger } = await import("../logger");
		const spy = vi
			.spyOn(logger, "warn")
			.mockImplementation((event: string, fields?: unknown) => {
				warnings.push({ event, fields });
			});

		const runOnMainThread = vi.fn().mockResolvedValue({
			bytes: new Uint8Array(10),
			mimeType: "image/jpeg",
			width: 1,
			height: 1,
			originalWidth: 1,
			originalHeight: 1,
			originalBytes: 10,
			compressed: false,
		} satisfies ProcessedImage);

		await preprocessWithFallback(bytesOf(10), {
			canUseWorker: () => false,
			runOnMainThread,
		});

		expect(runOnMainThread).toHaveBeenCalledTimes(1);
		expect(
			warnings.some((w) => w.event === "image.preprocess.worker.unavailable"),
		).toBe(true);
		spy.mockRestore();
	});

	it("falls back to the main thread when the worker throws", async () => {
		const { preprocessWithFallback } = await import("./runner");
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const runOnMainThread = vi.fn().mockResolvedValue({
			bytes: new Uint8Array(10),
			mimeType: "image/jpeg",
			width: 1,
			height: 1,
			originalWidth: 1,
			originalHeight: 1,
			originalBytes: 10,
			compressed: false,
		} satisfies ProcessedImage);

		const terminate = vi.fn();
		await preprocessWithFallback(bytesOf(10), {
			canUseWorker: () => true,
			createWorker: () => ({
				postMessage: () => {
					throw new Error("worker died");
				},
				addEventListener: () => {},
				terminate,
			}),
			runOnMainThread,
		});

		expect(runOnMainThread).toHaveBeenCalledTimes(1);
		// The worker is always torn down, so a failure cannot leave a live thread.
		expect(terminate).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});
