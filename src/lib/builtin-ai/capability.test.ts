import { describe, expect, it, vi } from "vitest";
import type { BuiltinLanguageModelApi } from "./capability";
import {
	deriveBuiltinConnectionStatus,
	detectBuiltinCapabilities,
	normalizeAvailability,
	queryLanguageModelAvailability,
	queryTranslatorAvailability,
	validatePromptLanguagePair,
} from "./capability";
import { createBuiltinLanguageModelClient } from "./language-model";

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
		expect(availability).toHaveBeenCalledWith({
			expectedInputs: [
				{ type: "text", languages: ["en", "ja", "es", "de", "fr"] },
				{ type: "image" },
			],
			expectedOutputs: [{ type: "text", languages: ["ja"] }],
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("uses the same language options for readiness and session creation", async () => {
		const availability = vi.fn().mockResolvedValue("available");
		const create = vi.fn().mockResolvedValue({
			prompt: vi.fn().mockResolvedValue("ok"),
			promptStreaming: vi.fn(),
			destroy: vi.fn(),
		});
		const api = { availability, create } as unknown as BuiltinLanguageModelApi;

		await queryLanguageModelAvailability("ja", { api });
		const client = createBuiltinLanguageModelClient({ api });
		await client.prompt({ text: "translate" }, { targetLanguage: "ja" });

		const availabilityOptions = availability.mock.calls[0]?.[0];
		const createOptions = create.mock.calls[0]?.[0];
		expect(availabilityOptions).toEqual(
			expect.objectContaining({
				expectedInputs: [
					expect.objectContaining({
						type: "text",
						languages: expect.any(Array),
					}),
					{ type: "image" },
				],
				expectedOutputs: [
					expect.objectContaining({ type: "text", languages: ["ja"] }),
				],
			}),
		);
		expect(availabilityOptions).not.toHaveProperty("language");
		expect(createOptions.expectedInputs).toEqual(
			availabilityOptions.expectedInputs,
		);
		expect(createOptions.expectedOutputs).toEqual(
			availabilityOptions.expectedOutputs,
		);
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
