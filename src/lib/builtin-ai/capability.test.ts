import { describe, expect, it, vi } from "vitest";

import {
	deriveBuiltinConnectionStatus,
	detectBuiltinCapabilities,
	normalizeAvailability,
	queryLanguageModelAvailability,
	queryTranslatorAvailability,
	validatePromptLanguagePair,
} from "./capability";

describe("Built-in AI capability detection", () => {
	it("only inspects API presence", () => {
		const scope = {
			Translator: {},
			LanguageDetector: undefined,
			LanguageModel: {},
		};
		expect(detectBuiltinCapabilities(scope)).toEqual({
			translator: true,
			languageDetector: false,
			languageModel: true,
		});
	});

	it("normalizes all four states and rejects unknown values", () => {
		expect(normalizeAvailability("unavailable")).toBe("unavailable");
		expect(normalizeAvailability("downloadable")).toBe("downloadable");
		expect(normalizeAvailability("downloading")).toBe("downloading");
		expect(normalizeAvailability("available")).toBe("available");
		expect(normalizeAvailability("future-state")).toBe("unavailable");
	});

	it("queries Translator readiness by language pair", async () => {
		const availability = vi.fn().mockResolvedValue("downloadable");
		const result = await queryTranslatorAvailability("zh", "en", {
			api: { availability, create: vi.fn() },
		});
		expect(result).toEqual({ state: "downloadable" });
		expect(availability).toHaveBeenCalledWith({
			sourceLanguage: "zh",
			targetLanguage: "en",
		});
	});

	it("treats an unknown Translator response as an unsupported pair", async () => {
		const result = await queryTranslatorAvailability("xx", "en", {
			api: {
				availability: vi.fn().mockResolvedValue("future-state"),
				create: vi.fn(),
			},
		});
		expect(result).toEqual({ state: "unavailable", reason: "language-pair" });
	});

	it("queries Prompt readiness by target language without network helpers", async () => {
		const availability = vi.fn().mockResolvedValue("available");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const result = await queryLanguageModelAvailability("ja", {
			api: { availability, create: vi.fn() },
		});
		expect(result).toEqual({ state: "available" });
		expect(availability).toHaveBeenCalledWith(
			expect.objectContaining({
				language: "ja",
				expectedInputs: [{ type: "text" }, { type: "image" }],
				expectedOutputs: [{ type: "text" }],
			}),
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("rejects Prompt API languages before a readiness call", async () => {
		const availability = vi.fn();
		const result = await queryLanguageModelAvailability("zh-Hans", {
			api: { availability, create: vi.fn() },
		});
		expect(result).toEqual({ state: "unavailable", reason: "language-pair" });
		expect(availability).not.toHaveBeenCalled();
	});
});

describe("Built-in readiness to connection state", () => {
	it("maps each readiness state to an honest connection status", () => {
		expect(deriveBuiltinConnectionStatus("available")).toEqual({
			status: "ok",
		});
		expect(deriveBuiltinConnectionStatus("downloadable")).toMatchObject({
			status: "failed",
			statusDetail: expect.stringContaining("下载"),
		});
		expect(deriveBuiltinConnectionStatus("downloading")).toMatchObject({
			status: "failed",
			statusDetail: expect.stringContaining("下载"),
		});
		expect(
			deriveBuiltinConnectionStatus({
				state: "unavailable",
				reason: "browser",
			}),
		).toMatchObject({
			status: "failed",
			statusDetail: expect.stringContaining("浏览器"),
		});
		expect(
			deriveBuiltinConnectionStatus({
				state: "unavailable",
				reason: "language-pair",
			}),
		).toMatchObject({
			status: "failed",
			statusDetail: expect.stringContaining("语言对"),
		});
		expect(
			deriveBuiltinConnectionStatus({ state: "unavailable", reason: "device" }),
		).toMatchObject({
			status: "failed",
			statusDetail: expect.stringContaining("设备"),
		});
	});
});

describe("Prompt API language preflight", () => {
	it("allows supported target/source languages and auto detection", () => {
		expect(
			validatePromptLanguagePair({
				sourceLanguage: "auto",
				targetLanguage: "en",
			}),
		).toEqual({
			ok: true,
		});
		expect(
			validatePromptLanguagePair({
				sourceLanguage: "ja",
				targetLanguage: "fr",
			}),
		).toEqual({
			ok: true,
		});
	});

	it("rejects Chinese and Korean without creating a call intent", () => {
		expect(
			validatePromptLanguagePair({ targetLanguage: "zh-Hans" }),
		).toMatchObject({
			ok: false,
		});
		expect(validatePromptLanguagePair({ targetLanguage: "ko" })).toMatchObject({
			ok: false,
		});
	});
});
