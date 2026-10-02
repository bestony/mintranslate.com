/**
 * Document Worker runner with a deterministic main-thread fallback.
 *
 * Both paths call `processDocumentJob`. The fallback is therefore a capability
 * choice, not a second parser. A failed Worker is terminated before the fallback
 * result is returned, including when the Worker rejects its job.
 */

import { logger } from "../logger";
import {
	processDocumentJob,
	type DocumentJob,
	type DocumentJobResult,
} from "./processor";
import type {
	DocumentWorkerRequest,
	DocumentWorkerResponse,
} from "./worker";

export interface DocumentWorkerLike {
	postMessage(message: DocumentWorkerRequest, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (event: { data: DocumentWorkerResponse }) => void,
	): void;
	addEventListener(
		type: "error",
		listener: (event: { error?: unknown; message?: string }) => void,
	): void;
	terminate(): void;
}

export interface DocumentRunnerDeps {
	readonly canUseWorker?: () => boolean;
	readonly createWorker?: () => DocumentWorkerLike | undefined;
	readonly runOnMainThread?: (job: DocumentJob) => Promise<DocumentJobResult>;
}

function defaultCanUseWorker(): boolean {
	return typeof globalThis.Worker === "function";
}

function defaultCreateWorker(): DocumentWorkerLike | undefined {
	try {
		return new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		}) as unknown as DocumentWorkerLike;
	} catch {
		return undefined;
	}
}

/** Run a local document operation off the main thread when the platform allows. */
export async function runDocumentJob(
	job: DocumentJob,
	deps: DocumentRunnerDeps = {},
): Promise<DocumentJobResult> {
	const canUseWorker = deps.canUseWorker ?? defaultCanUseWorker;
	const runOnMainThread =
		deps.runOnMainThread ?? ((input: DocumentJob) => processDocumentJob(input));

	if (!canUseWorker()) {
		logger.warn("document.worker.unavailable", {
			reason: typeof globalThis.Worker !== "function" ? "no Worker" : "disabled",
			path: "main-thread",
		});
		return runOnMainThread(job);
	}

	const worker = (deps.createWorker ?? defaultCreateWorker)();
	if (worker === undefined) {
		logger.warn("document.worker.unavailable", {
			reason: "worker construction failed",
			path: "main-thread",
		});
		return runOnMainThread(job);
	}

	try {
		const result = await runInWorker(worker, job);
		logger.debug("document.worker.path", { path: "worker" });
		return result;
	} catch (error) {
		logger.warn("document.worker.failed", {
			reason: error instanceof Error ? error.message : String(error),
			path: "main-thread",
		});
		return runOnMainThread(job);
	} finally {
		worker.terminate();
	}
}

function runInWorker(
	worker: DocumentWorkerLike,
	job: DocumentJob,
): Promise<DocumentJobResult> {
	return new Promise((resolve, reject) => {
		const id = 1;
		const onError = (event: { error?: unknown; message?: string }) => {
			reject(
				event.error instanceof Error
					? event.error
					: new Error(event.message ?? "文档 Worker 失败"),
			);
		};

		worker.addEventListener("error", onError);
		worker.addEventListener("message", (event) => {
			const response = event.data;
			if (response.id !== id) return;
			if (!response.ok) {
				reject(new Error(response.reason));
				return;
			}
			resolve(response.result);
		});

		// Transfer a copy. If a Worker fails after posting, the fallback still needs
		// the original bytes; transferring the caller's buffer would detach it.
		const wireJob = {
			...job,
			bytes: new Uint8Array(job.bytes),
		} as DocumentJob;
		worker.postMessage({ id, job: wireJob }, [wireJob.bytes.buffer]);
	});
}
