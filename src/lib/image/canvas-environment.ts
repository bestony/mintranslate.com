/**
 * Canvas-backed image environment.
 *
 * The only module that touches `createImageBitmap` and canvas encoding, so the
 * pipeline above it stays free of browser types and testable with a stand-in.
 *
 * Works in both a Worker and the main thread: `OffscreenCanvas` is preferred, and
 * a DOM canvas is used when it is unavailable (which is the main-thread fallback
 * path). `document` is therefore optional here, not assumed.
 */

import type { Dimensions } from "./model";
import type { DecodedImage, ImageEnvironment } from "./preprocess";

/** Structural type for the bitmaps `createImageBitmap` returns. */
interface ImageBitmapLike {
	readonly width: number;
	readonly height: number;
	close?: () => void;
}

/** Structural type for the canvas contexts used here. */
interface Canvas2DLike {
	drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
}

interface CanvasLike {
	getContext(id: "2d"): Canvas2DLike | null;
	convertToBlob?(options: { type: string; quality: number }): Promise<Blob>;
}

/** Whether this environment can run the canvas path at all. */
export function canUseCanvas(): boolean {
	return (
		typeof globalThis.createImageBitmap === "function" &&
		(typeof globalThis.OffscreenCanvas === "function" ||
			typeof globalThis.document !== "undefined")
	);
}

/** Create a canvas of the given size, preferring the offscreen kind. */
function createCanvas(target: Dimensions): CanvasLike {
	if (typeof globalThis.OffscreenCanvas === "function") {
		return new globalThis.OffscreenCanvas(
			target.width,
			target.height,
		) as unknown as CanvasLike;
	}

	if (typeof globalThis.document !== "undefined") {
		const canvas = globalThis.document.createElement("canvas");
		canvas.width = target.width;
		canvas.height = target.height;
		return canvas as unknown as CanvasLike;
	}

	throw new Error("没有可用的画布实现");
}

/** Encode a DOM canvas, which uses a callback rather than a promise. */
function encodeDomCanvas(
	canvas: HTMLCanvasElement,
	mimeType: string,
	quality: number,
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob === null) {
					reject(new Error("画布编码失败"));
					return;
				}
				void blob.arrayBuffer().then((buffer) => {
					resolve(new Uint8Array(buffer));
				}, reject);
			},
			mimeType,
			quality,
		);
	});
}

/**
 * The environment used in production.
 *
 * `imageOrientation: "from-image"` is what corrects a rotated photo: the decoded
 * bitmap already has the rotation applied, so drawing it produces upright pixels
 * and the orientation tag has nothing left to do.
 */
export function createCanvasEnvironment(): ImageEnvironment {
	return {
		async decode(bytes, mimeType) {
			const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
			const bitmap = (await globalThis.createImageBitmap(blob, {
				imageOrientation: "from-image",
			})) as unknown as ImageBitmapLike;

			return {
				width: bitmap.width,
				height: bitmap.height,
				handle: bitmap,
			};
		},

		async encode(image, target, quality, mimeType) {
			const canvas = createCanvas(target);
			const context = canvas.getContext("2d");
			if (context === null) throw new Error("无法获取画布上下文");

			const bitmap = image.handle as ImageBitmapLike;
			context.drawImage(bitmap, 0, 0, target.width, target.height);

			if (typeof canvas.convertToBlob === "function") {
				const blob = await canvas.convertToBlob({ type: mimeType, quality });
				return new Uint8Array(await blob.arrayBuffer());
			}

			return encodeDomCanvas(
				canvas as unknown as HTMLCanvasElement,
				mimeType,
				quality,
			);
		},

		release(image) {
			const bitmap = image.handle as ImageBitmapLike;
			bitmap.close?.();
		},
	};
}

/** A decoded image plus the environment that produced it. */
export type { DecodedImage };
