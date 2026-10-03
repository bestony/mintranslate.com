import { describe, expect, it, vi } from "vitest";

import type {
	BuiltinLanguageDetectorApi,
	BuiltinTranslatorApi,
	BuiltinTranslatorSession,
} from "./capability";
import {
	BuiltinLanguageDetectionError,
	BuiltinTranslatorNotReadyError,
	createBuiltinTranslatorClient,
} from "./translator";

function streaming(...chunks: string[]): AsyncIterable<string> {
	return (async function* () {
		for (const chunk of chunks) yield chunk;
	})();
}

function session(
	overrides: Partial<BuiltinTranslatorSession> = {},
): BuiltinTranslatorSession {
	return {
		translate: vi.fn().mockResolvedValue("translated"),
		translateStreaming: vi.fn().mockReturnValue(streaming("trans", "lated")),
		...overrides,
	};
}

describe("built-in Translator client", () => {
	it("creates with mapped language codes and forwards progress", async () => {
		let monitor: ((event: { downloadProgress?: number }) => void) | undefined;
		const created = session();
		const api: BuiltinTranslatorApi = {
			availability: vi.fn().mockResolvedValue("downloadable"),
			create: vi.fn().mockImplementation((options) => {
				monitor = options.monitor;
				return created;
			}),
		};
		const progress: number[] = [];
		const client = createBuiltinTranslatorClient({ api });

		await client.create("zh-Hans", "en", {
			onProgress: (value) => progress.push(value),
		});
		monitor?.({ downloadProgress: 0.4 });
		expect(api.create).toHaveBeenCalledWith(
			expect.objectContaining({ sourceLanguage: "zh", targetLanguage: "en" }),
		);
		expect(progress).toEqual([0.4]);
	});

	it("does not create a downloadable model before explicit activation", async () => {
		const create = vi.fn().mockResolvedValue(session());
		const api: BuiltinTranslatorApi = {
			availability: vi.fn().mockResolvedValue("downloadable"),
			create,
		};
		const client = createBuiltinTranslatorClient({ api });

		await expect(client.translate("en", "ja", "hello")).rejects.toBeInstanceOf(
			BuiltinTranslatorNotReadyError,
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("translates normally and streams chunks after creation", async () => {
		const translator = session();
		const api: BuiltinTranslatorApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockResolvedValue(translator),
		};
		const client = createBuiltinTranslatorClient({ api });

		await expect(client.translate("en", "ja", "hello")).resolves.toEqual({
			text: "translated",
		});
		const chunks: string[] = [];
		await expect(
			client.translateStreaming("en", "ja", "hello", {
				onChunk: (chunk) => chunks.push(chunk),
			}),
		).resolves.toEqual({ text: "translated" });
		expect(chunks).toEqual(["trans", "lated"]);
		expect(translator.translateStreaming).toHaveBeenCalledTimes(1);
	});

	it("detects before translating when source is auto", async () => {
		const order: string[] = [];
		const translator = session({
			translate: vi.fn().mockImplementation(async () => {
				order.push("translate");
				return "ok";
			}),
		});
		const detector: BuiltinLanguageDetectorApi = {
			create: vi.fn().mockResolvedValue({
				detect: vi.fn().mockImplementation(async () => {
					order.push("detect");
					return [{ detectedLanguage: "en", confidence: 0.9 }];
				}),
			}),
		};
		const client = createBuiltinTranslatorClient({
			api: {
				availability: vi.fn().mockResolvedValue("available"),
				create: vi.fn().mockResolvedValue(translator),
			},
			detectorApi: detector,
		});

		await expect(
			client.translate("auto", "ja", "hello"),
		).resolves.toMatchObject({
			text: "ok",
			detectedLang: { code: "en", confidence: 0.9 },
		});
		expect(order).toEqual(["detect", "translate"]);
	});

	it("refuses an empty or low-confidence detection before translation", async () => {
		const translate = vi.fn();
		const client = createBuiltinTranslatorClient({
			api: {
				availability: vi.fn().mockResolvedValue("available"),
				create: vi.fn().mockResolvedValue(session({ translate })),
			},
			detectorApi: {
				create: vi.fn().mockResolvedValue({
					detect: vi
						.fn()
						.mockResolvedValue([{ detectedLanguage: "en", confidence: 0.2 }]),
				}),
			},
		});

		await expect(
			client.translate("auto", "ja", "hello"),
		).rejects.toBeInstanceOf(BuiltinLanguageDetectionError);
		expect(translate).not.toHaveBeenCalled();
	});
});
