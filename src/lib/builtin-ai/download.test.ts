import { describe, expect, it, vi } from "vitest";
import {
	activateBuiltinDownload,
	downloadRequestFromError,
	INITIAL_BUILTIN_DOWNLOAD_STATE,
	reduceBuiltinDownload,
} from "./download";
import {
	type BuiltinLanguageModelClient,
	BuiltinLanguageModelNotReadyError,
} from "./language-model";
import { BuiltinTranslatorNotReadyError } from "./translator";

describe("built-in download state", () => {
	it("keeps the concrete Translator pair until explicit activation", () => {
		const error = new BuiltinTranslatorNotReadyError(
			{ state: "downloadable" },
			{ sourceLanguage: "zh-Hans", targetLanguage: "en" },
		);
		const request = downloadRequestFromError(error);

		expect(request).toEqual({
			provider: "builtin-translator",
			sourceLanguage: "zh-Hans",
			targetLanguage: "en",
			availability: "downloadable",
		});
		expect(request).toBeDefined();
		if (request === undefined) throw new Error("missing download request");
		expect(
			reduceBuiltinDownload(INITIAL_BUILTIN_DOWNLOAD_STATE, {
				type: "required",
				request,
			}),
		).toMatchObject({ phase: "required", request });
	});

	it("represents click, progress, completion, and retryable failure", () => {
		const request = {
			provider: "builtin-translator" as const,
			sourceLanguage: "ja",
			targetLanguage: "en",
			availability: "downloadable" as const,
		};
		const required = reduceBuiltinDownload(INITIAL_BUILTIN_DOWNLOAD_STATE, {
			type: "required",
			request,
		});
		const started = reduceBuiltinDownload(required, { type: "start" });
		expect(started).toMatchObject({ phase: "downloading", progress: 0 });
		const progressed = reduceBuiltinDownload(started, {
			type: "progress",
			value: 0.4,
		});
		expect(progressed.progress).toBe(0.4);
		const failed = reduceBuiltinDownload(progressed, {
			type: "failed",
			message: "下载失败",
		});
		expect(failed).toMatchObject({ phase: "failed", error: "下载失败" });
		const retried = reduceBuiltinDownload(failed, { type: "start" });
		expect(retried).toMatchObject({ phase: "downloading", progress: 0 });
		const complete = reduceBuiltinDownload(retried, { type: "complete" });
		expect(complete).toMatchObject({ phase: "complete", progress: 1 });
	});

	it("extracts the target language for a Prompt API download", () => {
		const error = new BuiltinLanguageModelNotReadyError(
			{ state: "downloading" },
			{ targetLanguage: "fr" },
		);
		expect(downloadRequestFromError(error)).toEqual({
			provider: "builtin-multimodal",
			targetLanguage: "fr",
			availability: "downloading",
		});
	});

	it("activates Prompt API downloads with the current target language", async () => {
		const languageModel = {
			create: vi.fn().mockResolvedValue(undefined),
		} as unknown as BuiltinLanguageModelClient;
		const request = {
			provider: "builtin-multimodal" as const,
			targetLanguage: "ja",
			availability: "downloadable" as const,
		};
		const onProgress = vi.fn();

		await activateBuiltinDownload(request, { languageModel }, onProgress);

		expect(languageModel.create).toHaveBeenCalledWith({
			targetLanguage: "ja",
			onProgress,
			signal: undefined,
		});
	});
});
