import { describe, expect, it, vi } from "vitest";

import type {
	BuiltinCreateMonitor,
	BuiltinLanguageModelApi,
	BuiltinLanguageModelSession,
} from "./capability";
import {
	BuiltinLanguageModelNotReadyError,
	createBuiltinLanguageModelClient,
} from "./language-model";

function streaming(...chunks: string[]): AsyncIterable<string> {
	return (async function* () {
		for (const chunk of chunks) yield chunk;
	})();
}

function session(): BuiltinLanguageModelSession {
	return {
		prompt: vi.fn().mockResolvedValue("[{}]"),
		promptStreaming: vi.fn().mockReturnValue(streaming("[", "{}", "]")),
		destroy: vi.fn(),
	};
}

describe("built-in LanguageModel client", () => {
	it("includes the request system instruction in the Prompt API session", async () => {
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockResolvedValue(session()),
		};
		const client = createBuiltinLanguageModelClient({ api });

		await client.prompt(
			{ text: "read the image" },
			{
				targetLanguage: "ja",
				systemInstruction: "Use the glossary and the formal style.",
			},
		);

		expect(api.create).toHaveBeenCalledWith(
			expect.objectContaining({
				initialPrompts: [
					{
						role: "system",
						content:
							"Translate into ja.\n\nUse the glossary and the formal style.",
					},
				],
			}),
		);
	});

	it("creates with expected inputs and outputs and forwards monitor progress", async () => {
		let progressEvent: ((event: { loaded: number }) => void) | undefined;
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("downloadable"),
			create: vi.fn().mockImplementation((options) => {
				(options.monitor as (monitor: BuiltinCreateMonitor) => void)?.({
					addEventListener: (_type: string, listener) => {
						progressEvent = listener;
					},
				});
				return session();
			}),
		};
		const progress: number[] = [];
		const client = createBuiltinLanguageModelClient({ api });

		await client.create({
			targetLanguage: "en",
			onProgress: (value) => progress.push(value),
		});
		progressEvent?.({ loaded: 0.5 });
		expect(api.create).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedInputs: expect.arrayContaining([
					expect.objectContaining({ type: "text" }),
					expect.objectContaining({ type: "image" }),
				]),
				expectedOutputs: expect.arrayContaining([
					expect.objectContaining({ type: "text" }),
				]),
			}),
		);
		expect(progress).toEqual([0.5]);
	});

	it("does not create a downloadable session implicitly", async () => {
		const create = vi.fn();
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("downloadable"),
			create,
		};
		const client = createBuiltinLanguageModelClient({ api });
		await expect(client.prompt({ text: "translate" })).rejects.toBeInstanceOf(
			BuiltinLanguageModelNotReadyError,
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("passes images and responseConstraint, streams, and destroys", async () => {
		const first = session();
		const second = session();
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi
				.fn()
				.mockResolvedValueOnce(first)
				.mockResolvedValueOnce(second),
		};
		const client = createBuiltinLanguageModelClient({ api });
		const constraint = { type: "array" };

		await expect(
			client.prompt(
				{ text: "read", images: [{ base64: "AQI=", mimeType: "image/png" }] },
				{ responseConstraint: constraint },
			),
		).resolves.toBe("[{}]");
		const streamed = await client.promptStreaming(
			{ text: "read" },
			{ responseConstraint: constraint },
		);
		expect(streamed).toBe("[{}]");
		expect(first.prompt).toHaveBeenCalledWith(
			[
				{ type: "text", value: "read" },
				expect.objectContaining({ type: "image" }),
			],
			{ signal: undefined, responseConstraint: constraint },
		);
		expect(second.promptStreaming).toHaveBeenCalledWith("read", {
			signal: undefined,
			responseConstraint: constraint,
		});
		client.destroy();
		expect(first.destroy).toHaveBeenCalledOnce();
		expect(second.destroy).toHaveBeenCalledOnce();
	});

	it("forwards each Prompt API streaming chunk to onChunk", async () => {
		const current = session();
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockResolvedValue(current),
		};
		const client = createBuiltinLanguageModelClient({ api });
		const onChunk = vi.fn();

		await expect(
			client.promptStreaming({ text: "read" }, { onChunk }),
		).resolves.toBe("[{}]");
		expect(onChunk.mock.calls).toEqual([["["], ["{}"], ["]"]]);
	});

	it("forwards an abort signal to the local session", async () => {
		const current = session();
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockResolvedValue(current),
		};
		const client = createBuiltinLanguageModelClient({ api });
		const controller = new AbortController();

		await client.prompt({ text: "read" }, { signal: controller.signal });
		expect(current.prompt).toHaveBeenCalledWith(
			"read",
			expect.objectContaining({ signal: controller.signal }),
		);
	});
});

describe("request session isolation", () => {
	it("creates an independent session with each request language and instruction", async () => {
		const first = session();
		const second = session();
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi
				.fn()
				.mockResolvedValueOnce(first)
				.mockResolvedValueOnce(second),
		};
		const client = createBuiltinLanguageModelClient({ api });

		await client.prompt(
			{ text: "first image" },
			{ targetLanguage: "ja", systemInstruction: "Use formal language." },
		);
		await client.prompt(
			{ text: "second image" },
			{ targetLanguage: "fr", systemInstruction: "Use simple language." },
		);

		expect(api.create).toHaveBeenCalledTimes(2);
		expect(api.create).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				initialPrompts: [
					{
						role: "system",
						content: "Translate into fr.\n\nUse simple language.",
					},
				],
			}),
		);
		expect(first.prompt).toHaveBeenCalledOnce();
		expect(second.prompt).toHaveBeenCalledWith(
			"second image",
			expect.anything(),
		);
		expect(first.destroy).toHaveBeenCalledOnce();
		expect(second.destroy).toHaveBeenCalledOnce();
	});

	it("releases the download session before creating a request session", async () => {
		const downloaded = session();
		const request = session();
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi
				.fn()
				.mockResolvedValueOnce(downloaded)
				.mockResolvedValueOnce(request),
		};
		const client = createBuiltinLanguageModelClient({ api });

		await client.create({ targetLanguage: "en" });
		expect(downloaded.destroy).toHaveBeenCalledOnce();
		await client.prompt({ text: "read" }, { targetLanguage: "ja" });
		expect(api.create).toHaveBeenCalledTimes(2);
		expect(downloaded.prompt).not.toHaveBeenCalled();
		expect(request.destroy).toHaveBeenCalledOnce();
	});

	it.each([
		"prompt",
		"promptStreaming",
	] as const)("destroys the request session when %s fails", async (method) => {
		const current = session();
		const error = new Error("local model failed");
		current.prompt = vi.fn().mockRejectedValue(error);
		current.promptStreaming = vi.fn().mockReturnValue(
			(async function* () {
				yield "partial";
				throw error;
			})(),
		);
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockResolvedValue(current),
		};
		const client = createBuiltinLanguageModelClient({ api });

		await expect(client[method]({ text: "read" })).rejects.toBe(error);
		expect(current.destroy).toHaveBeenCalledOnce();
	});

	it("destroys a session returned after its create signal was aborted", async () => {
		const current = session();
		let resolveCreate:
			| ((value: BuiltinLanguageModelSession) => void)
			| undefined;
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockImplementation(
				() =>
					new Promise<BuiltinLanguageModelSession>((resolve) => {
						resolveCreate = resolve;
					}),
			),
		};
		const client = createBuiltinLanguageModelClient({ api });
		const controller = new AbortController();
		const run = client.prompt({ text: "read" }, { signal: controller.signal });
		await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
		controller.abort();
		resolveCreate?.(current);

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(current.destroy).toHaveBeenCalledOnce();
		expect(current.prompt).not.toHaveBeenCalled();
	});

	it.each([
		"prompt",
		"promptStreaming",
	] as const)("destroys the active %s session on abort and rejects late output", async (method) => {
		const current = session();
		let release: (() => void) | undefined;
		const delayed = new Promise<void>((resolve) => {
			release = resolve;
		});
		current.prompt = vi.fn().mockImplementation(async () => {
			await delayed;
			return "late";
		});
		current.promptStreaming = vi.fn().mockReturnValue(
			(async function* () {
				await delayed;
				yield "late";
			})(),
		);
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockResolvedValue(current),
		};
		const client = createBuiltinLanguageModelClient({ api });
		const controller = new AbortController();
		const run = client[method]({ text: "read" }, { signal: controller.signal });
		await vi.waitFor(() => expect(current[method]).toHaveBeenCalledOnce());
		controller.abort();
		expect(current.destroy).toHaveBeenCalledOnce();
		release?.();
		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(current.destroy).toHaveBeenCalledOnce();
	});
});
