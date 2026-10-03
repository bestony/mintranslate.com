/**
 * Pure state for an explicitly activated built-in model download.
 *
 * The workspace owns the pending request and calls the existing model client
 * only from the user action. This reducer describes the visible states without
 * adding a timer, queue, or retry loop.
 */

import {
	type BuiltinLanguageModelClient,
	BuiltinLanguageModelNotReadyError,
} from "./language-model";
import {
	type BuiltinTranslatorClient,
	BuiltinTranslatorNotReadyError,
} from "./translator";

export type BuiltinDownloadProvider =
	| "builtin-translator"
	| "builtin-multimodal";

export interface BuiltinDownloadRequest {
	readonly provider: BuiltinDownloadProvider;
	readonly sourceLanguage?: string;
	readonly targetLanguage: string;
	readonly availability: "downloadable" | "downloading";
}

export type BuiltinDownloadPhase =
	| "idle"
	| "required"
	| "downloading"
	| "failed"
	| "complete";

export interface BuiltinDownloadState {
	readonly phase: BuiltinDownloadPhase;
	readonly request?: BuiltinDownloadRequest;
	readonly progress?: number;
	readonly error?: string;
}

export const INITIAL_BUILTIN_DOWNLOAD_STATE: BuiltinDownloadState = {
	phase: "idle",
};

export type BuiltinDownloadAction =
	| { readonly type: "required"; readonly request: BuiltinDownloadRequest }
	| { readonly type: "start" }
	| { readonly type: "progress"; readonly value: number }
	| { readonly type: "complete" }
	| { readonly type: "failed"; readonly message: string }
	| { readonly type: "reset" };

function clampProgress(value: number): number {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/** Apply one visible download transition without side effects. */
export function reduceBuiltinDownload(
	state: BuiltinDownloadState,
	action: BuiltinDownloadAction,
): BuiltinDownloadState {
	switch (action.type) {
		case "required":
			return {
				phase: "required",
				request: action.request,
			};
		case "start":
			return state.request === undefined
				? state
				: { phase: "downloading", request: state.request, progress: 0 };
		case "progress":
			return state.request === undefined
				? state
				: {
						phase: "downloading",
						request: state.request,
						progress: clampProgress(action.value),
					};
		case "complete":
			return state.request === undefined
				? state
				: { phase: "complete", request: state.request, progress: 1 };
		case "failed":
			return state.request === undefined
				? state
				: {
						phase: "failed",
						request: state.request,
						progress: state.progress,
						error: action.message,
					};
		case "reset":
			return INITIAL_BUILTIN_DOWNLOAD_STATE;
	}
}

/** Extract the concrete request that caused a model call to need activation. */
export function downloadRequestFromError(
	error: unknown,
): BuiltinDownloadRequest | undefined {
	if (error instanceof BuiltinTranslatorNotReadyError) {
		if (
			(error.readiness.state !== "downloadable" &&
				error.readiness.state !== "downloading") ||
			error.sourceLanguage === undefined ||
			error.targetLanguage === undefined
		)
			return undefined;
		return {
			provider: "builtin-translator",
			sourceLanguage: error.sourceLanguage,
			targetLanguage: error.targetLanguage,
			availability: error.readiness.state,
		};
	}

	if (error instanceof BuiltinLanguageModelNotReadyError) {
		if (
			(error.readiness.state !== "downloadable" &&
				error.readiness.state !== "downloading") ||
			error.targetLanguage === undefined
		)
			return undefined;
		return {
			provider: "builtin-multimodal",
			targetLanguage: error.targetLanguage,
			availability: error.readiness.state,
		};
	}

	return undefined;
}

/** Start the explicit Translator download for a concrete pending pair. */
export async function activateBuiltinDownload(
	request: BuiltinDownloadRequest,
	clients: {
		readonly translator?: BuiltinTranslatorClient;
		readonly languageModel?: BuiltinLanguageModelClient;
	},
	onProgress: (progress: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (request.provider === "builtin-translator") {
		if (
			clients.translator === undefined ||
			request.sourceLanguage === undefined
		)
			throw new Error("内置翻译下载缺少语言对。");
		await clients.translator.create(
			request.sourceLanguage,
			request.targetLanguage,
			{ onProgress, signal },
		);
		return;
	}

	if (clients.languageModel === undefined)
		throw new Error("内置多模态下载客户端未初始化。");
	await clients.languageModel.create({
		targetLanguage: request.targetLanguage,
		onProgress,
		signal,
	});
}
