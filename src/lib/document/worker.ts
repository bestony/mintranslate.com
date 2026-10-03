/** Worker entry for local document parsing and rebuilding. */

import { type DocumentJob, processDocumentJob } from "./processor";

export interface DocumentWorkerRequest {
	readonly id: number;
	readonly job: DocumentJob;
}

export type DocumentWorkerResponse =
	| {
			readonly id: number;
			readonly ok: true;
			readonly result: Awaited<ReturnType<typeof processDocumentJob>>;
	  }
	| { readonly id: number; readonly ok: false; readonly reason: string };

interface WorkerScope {
	postMessage(message: DocumentWorkerResponse, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (event: { data: DocumentWorkerRequest }) => void,
	): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
	const request = event.data;
	void (async () => {
		try {
			const result = await processDocumentJob(request.job);
			const transfer: Transferable[] = [];
			if (result.kind === "rebuilt") transfer.push(result.bytes.buffer);
			if (result.kind === "pdf") {
				// PDF extraction contains strings only, so there is no transferable
				// payload in this branch.
			}
			scope.postMessage({ id: request.id, ok: true, result }, transfer);
		} catch (error) {
			scope.postMessage({
				id: request.id,
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	})();
});
