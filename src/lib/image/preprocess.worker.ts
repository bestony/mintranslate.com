/**
 * Image preprocessing worker entry.
 *
 * Deliberately thin: it imports the same `preprocessImage` the main thread uses and
 * the same canvas environment, so there is exactly one implementation of the
 * pipeline. Everything worth testing lives in those modules.
 *
 * Offloading matters because decoding a 10MB photo and re-encoding it is hundreds
 * of milliseconds of solid work; on the main thread that is a frozen interface.
 */

import { createCanvasEnvironment } from "./canvas-environment";
import type { ImageBytes } from "./model";
import { preprocessImage } from "./preprocess";

/** Request the main thread sends. */
export interface PreprocessRequest {
	readonly id: number;
	readonly bytes: Uint8Array;
	readonly mimeType: string;
}

/** Reply the worker sends. */
export type PreprocessResponse =
	| {
			readonly id: number;
			readonly ok: true;
			readonly bytes: Uint8Array;
			readonly mimeType: string;
			readonly width: number;
			readonly height: number;
			readonly originalWidth: number;
			readonly originalHeight: number;
			readonly originalBytes: number;
			readonly compressed: boolean;
	  }
	| { readonly id: number; readonly ok: false; readonly reason: string };

/** The worker's scope, structurally typed to avoid depending on DOM worker types. */
interface WorkerScope {
	postMessage(message: PreprocessResponse, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (event: { data: PreprocessRequest }) => void,
	): void;
}

const scope = globalThis as unknown as WorkerScope;
const environment = createCanvasEnvironment();

scope.addEventListener("message", (event) => {
	const request = event.data;

	void (async () => {
		try {
			const input: ImageBytes = {
				bytes: new Uint8Array(request.bytes),
				mimeType: request.mimeType,
			};
			const processed = await preprocessImage(input, environment);

			// The buffer is transferred rather than copied: it is the largest object
			// in the exchange.
			const buffer = processed.bytes.buffer as ArrayBuffer;
			scope.postMessage(
				{
					id: request.id,
					ok: true,
					bytes: processed.bytes,
					mimeType: processed.mimeType,
					width: processed.width,
					height: processed.height,
					originalWidth: processed.originalWidth,
					originalHeight: processed.originalHeight,
					originalBytes: processed.originalBytes,
					compressed: processed.compressed,
				},
				[buffer],
			);
		} catch (error) {
			scope.postMessage({
				id: request.id,
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	})();
});
