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
		const current = session();
		const api: BuiltinLanguageModelApi = {
			availability: vi.fn().mockResolvedValue("available"),
			create: vi.fn().mockResolvedValue(current),
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
		expect(current.prompt).toHaveBeenCalledWith(
			[
				{ type: "text", value: "read" },
				expect.objectContaining({ type: "image" }),
			],
			{ signal: undefined, responseConstraint: constraint },
		);
		expect(current.promptStreaming).toHaveBeenCalledWith("read", {
			signal: undefined,
			responseConstraint: constraint,
		});
		client.destroy();
		expect(current.destroy).toHaveBeenCalledOnce();
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
