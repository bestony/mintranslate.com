/**
 * Preprocessing runner: picks the Worker, falls back to the main thread.
 *
 * The fallback is not a degraded feature, it is the same feature on a different
 * thread. That is why both paths call the identical `preprocessImage` with the
 * identical environment, and why the only observable difference is a log line:
 * a browser without worker-side canvas support gets the same pixels, just with a
 * possible pause while it works.
 */

import { logger } from "../logger";
import { canUseCanvas, createCanvasEnvironment } from "./canvas-environment";
import type { ImageBytes, ProcessedImage } from "./model";
import { preprocessImage } from "./preprocess";
import type {
	PreprocessRequest,
	PreprocessResponse,
} from "./preprocess.worker";

/** A worker handle, structurally typed so tests can supply one. */
export interface WorkerLike {
	postMessage(message: PreprocessRequest, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (event: { data: PreprocessResponse }) => void,
	): void;
	terminate(): void;
}

/** Injectable dependencies, so the fallback decision is testable. */
export interface PreprocessRunnerDeps {
	/** Whether worker-side canvas is usable. */
	readonly canUseWorker?: () => boolean;
	/** Creates a worker, or throws/returns undefined when unavailable. */
	readonly createWorker?: () => WorkerLike | undefined;
	/** Main-thread path. */
	readonly runOnMainThread?: (input: ImageBytes) => Promise<ProcessedImage>;
}

/** Whether worker-side canvas support is present. */
function defaultCanUseWorker(): boolean {
	if (typeof globalThis.Worker !== "function") return false;
	// `OffscreenCanvas` inside a worker is the capability that matters; without it
	// the worker would have no way to draw or encode.
	return typeof globalThis.OffscreenCanvas === "function" && canUseCanvas();
}

/** Create the real worker through the bundler's worker URL form. */
function defaultCreateWorker(): WorkerLike | undefined {
	try {
		return new Worker(new URL("./preprocess.worker.ts", import.meta.url), {
			type: "module",
		}) as unknown as WorkerLike;
	} catch {
		return undefined;
	}
}

/**
 * Preprocess an image, off the main thread when possible.
 *
 * The decision and the reason are logged, so "the interface paused on my old
 * tablet" can be answered from the logs rather than guessed at.
 */
export async function preprocessWithFallback(
	input: ImageBytes,
	deps: PreprocessRunnerDeps = {},
): Promise<ProcessedImage> {
	const canUseWorker = deps.canUseWorker ?? defaultCanUseWorker;
	const runOnMainThread =
		deps.runOnMainThread ??
		((bytes: ImageBytes) => preprocessImage(bytes, createCanvasEnvironment()));

	if (!canUseWorker()) {
		logger.warn("image.preprocess.worker.unavailable", {
			reason:
				typeof globalThis.OffscreenCanvas !== "function"
					? "no OffscreenCanvas"
					: "no Worker",
			path: "main-thread",
		});
		return runOnMainThread(input);
	}

	const createWorker = deps.createWorker ?? defaultCreateWorker;
	const worker = createWorker();

	if (worker === undefined) {
		logger.warn("image.preprocess.worker.unavailable", {
			reason: "worker construction failed",
			path: "main-thread",
		});
		return runOnMainThread(input);
	}

	try {
		const result = await runInWorker(worker, input);
		logger.debug("image.preprocess.path", { path: "worker" });
		return result;
	} catch (error) {
		// A worker that fails mid-flight is retried on the main thread rather than
		// surfaced: the user asked for a translation, not for a threading error.
		logger.warn("image.preprocess.worker.failed", {
			reason: error instanceof Error ? error.message : String(error),
			path: "main-thread",
		});
		return runOnMainThread(input);
	} finally {
		worker.terminate();
	}
}

/** Send one job to a worker and await its reply. */
function runInWorker(
	worker: WorkerLike,
	input: ImageBytes,
): Promise<ProcessedImage> {
	return new Promise((resolve, reject) => {
		const id = 1;

		worker.addEventListener("message", (event) => {
			const response = event.data;
			if (response.id !== id) return;

			if (!response.ok) {
				reject(new Error(response.reason));
				return;
			}

			resolve({
				// A transferred buffer arrives as a fresh array; copying into this
				// realm's view keeps the type honest.
				bytes: new Uint8Array(response.bytes),
				mimeType: response.mimeType,
				width: response.width,
				height: response.height,
				originalWidth: response.originalWidth,
				originalHeight: response.originalHeight,
				originalBytes: response.originalBytes,
				compressed: response.compressed,
			});
		});

		const buffer = input.bytes.buffer as ArrayBuffer;
		worker.postMessage({ id, bytes: input.bytes, mimeType: input.mimeType }, [
			buffer,
		]);
	});
}
