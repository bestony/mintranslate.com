/** @vitest-environment node */

import { describe, expect, it, vi } from "vitest";

import { logger } from "../logger";
import { type DocumentJob, processDocumentJob } from "./processor";
import { type DocumentWorkerLike, runDocumentJob } from "./runner";
import { writePackage } from "./zip";
import type {
	DocumentWorkerRequest,
	DocumentWorkerResponse,
} from "./worker";

const job: DocumentJob = {
	kind: "parse",
	format: "docx",
	bytes: writePackage({
		"word/document.xml": new TextEncoder().encode(
			"<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>",
		),
	}),
};

class FakeWorker implements DocumentWorkerLike {
	private readonly listeners = new Map<
		"message" | "error",
		((event: { data?: DocumentWorkerResponse; message?: string }) => void)[]
	>();
	terminated = false;

	postMessage(message: DocumentWorkerRequest): void {
		void processDocumentJob(message.job).then((result) => {
			for (const listener of this.listeners.get("message") ?? [])
				listener({ data: { id: message.id, ok: true, result } });
		});
	}

	addEventListener(
		type: "message",
		listener: (event: { data: DocumentWorkerResponse }) => void,
	): void;
	addEventListener(
		type: "error",
		listener: (event: { error?: unknown; message?: string }) => void,
	): void;
	addEventListener(
		type: "message" | "error",
		listener: (event: {
			data?: DocumentWorkerResponse;
			error?: unknown;
			message?: string;
		}) => void,
	): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	emitError(message: string): void {
		for (const listener of this.listeners.get("error") ?? []) listener({ message });
	}

	terminate(): void {
		this.terminated = true;
	}
}

describe("document Worker runner", () => {
	it("uses the same implementation in Worker and fallback paths", async () => {
		const worker = new FakeWorker();
		const workerResult = await runDocumentJob(job, {
			canUseWorker: () => true,
			createWorker: () => worker,
		});
		const fallbackResult = await runDocumentJob(job, {
			canUseWorker: () => false,
		});

		expect(workerResult).toEqual(fallbackResult);
		expect(worker.terminated).toBe(true);
	});

	it("logs a warning when Worker support is unavailable", async () => {
		const warning = vi.spyOn(logger, "warn");
		await runDocumentJob(job, { canUseWorker: () => false });
		expect(warning).toHaveBeenCalledWith(
		"document.worker.unavailable",
		expect.objectContaining({ path: "main-thread" }),
	);
		warning.mockRestore();
	});

	it("does not open a network path while parsing", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		await processDocumentJob(job);
		expect(fetch).not.toHaveBeenCalled();
		fetch.mockRestore();
	});

	it("terminates a failed Worker before falling back", async () => {
		const worker = new FakeWorker();
		worker.postMessage = () => worker.emitError("worker failed");
		const result = await runDocumentJob(job, {
			canUseWorker: () => true,
			createWorker: () => worker,
		});
		 expect(result.kind).toBe("parsed");
		 expect(worker.terminated).toBe(true);
	});
});
