/**
 * Main-thread wrapper for Chrome's Prompt API (`LanguageModel`).
 *
 * The wrapper owns browser session creation and destruction. Callers provide
 * already-processed image bytes and an explicit response constraint; no image
 * is persisted or sent through an external adapter.
 */

import { logger } from "../logger";
import {
	type BuiltinApiScope,
	type BuiltinLanguageModelApi,
	type BuiltinLanguageModelSession,
	type BuiltinReadiness,
	queryLanguageModelAvailability,
} from "./capability";
import { monitorBuiltinDownload } from "./monitor";

/** A processed image supplied to Prompt API. */
export interface BuiltinModelImage {
	readonly base64: string;
	readonly mimeType: string;
}

/** Prompt input accepted by the local model. */
export interface BuiltinModelPromptInput {
	readonly text: string;
	readonly images?: readonly BuiltinModelImage[];
}

/** Explicit creation options, usually called from a user gesture. */
export interface BuiltinLanguageModelCreateOptions {
	readonly targetLanguage?: string;
	readonly systemInstruction?: string;
	readonly onProgress?: (progress: number) => void;
	readonly signal?: AbortSignal;
}

/** Prompt invocation options. */
export interface BuiltinLanguageModelPromptOptions {
	readonly signal?: AbortSignal;
	readonly responseConstraint?: unknown;
	readonly targetLanguage?: string;
	readonly systemInstruction?: string;
	readonly onChunk?: (text: string) => void;
}

/** Error raised when a session needs explicit activation or is unavailable. */
export class BuiltinLanguageModelNotReadyError extends Error {
	readonly readiness: BuiltinReadiness;
	readonly targetLanguage?: string;

	constructor(
		readiness: BuiltinReadiness,
		options?: { readonly targetLanguage: string },
	) {
		super(
			readiness.state === "downloadable"
				? "内置多模态模型需要用户点击后下载。"
				: readiness.state === "downloading"
					? "内置多模态模型正在下载。"
					: "内置多模态模型当前不可用。",
		);
		this.name = "BuiltinLanguageModelNotReadyError";
		this.readiness = readiness;
		this.targetLanguage = options?.targetLanguage;
	}
}

/** Main-thread Prompt API client. */
export interface BuiltinLanguageModelClient {
	availability(targetLanguage?: string): Promise<BuiltinReadiness>;
	/** Explicitly create/download a session after a user gesture. */
	create(options?: BuiltinLanguageModelCreateOptions): Promise<void>;
	prompt(
		input: BuiltinModelPromptInput,
		options?: BuiltinLanguageModelPromptOptions,
	): Promise<string>;
	promptStreaming(
		input: BuiltinModelPromptInput,
		options?: BuiltinLanguageModelPromptOptions,
	): Promise<string>;
	destroy(): void;
}

function base64Bytes(value: string): Uint8Array {
	if (typeof globalThis.atob === "function") {
		const decoded = globalThis.atob(value);
		const bytes = new Uint8Array(decoded.length);
		for (let index = 0; index < decoded.length; index += 1)
			bytes[index] = decoded.charCodeAt(index);
		return bytes;
	}
	// Browser builds use atob. This branch keeps injected test environments safe.
	return new Uint8Array();
}

function promptInput(input: BuiltinModelPromptInput): unknown {
	if (input.images === undefined || input.images.length === 0)
		return input.text;
	return [
		{ type: "text", value: input.text },
		...input.images.map((image) => ({
			type: "image",
			value: new Blob([base64Bytes(image.base64) as unknown as BlobPart], {
				type: image.mimeType,
			}),
		})),
	];
}

/** Create the local Prompt API wrapper. */
export function createBuiltinLanguageModelClient(
	options: {
		readonly api?: BuiltinLanguageModelApi;
		readonly scope?: BuiltinApiScope;
		readonly expectedInputs?: readonly Record<string, unknown>[];
		readonly expectedOutputs?: readonly Record<string, unknown>[];
		readonly onDownloadProgress?: (progress: number) => void;
	} = {},
): BuiltinLanguageModelClient {
	const scope = options.scope ?? (globalThis as BuiltinApiScope);
	const api = options.api ?? scope.LanguageModel;
	const sessions = new Set<BuiltinLanguageModelSession>();
	let generation = 0;

	function release(current: BuiltinLanguageModelSession): void {
		if (!sessions.delete(current)) return;
		current.destroy?.();
		logger.debug("builtin.language-model.session.destroyed", {
			activeSessions: sessions.size,
		});
	}

	async function availability(
		targetLanguage?: string,
	): Promise<BuiltinReadiness> {
		if (api === undefined) return { state: "unavailable", reason: "browser" };
		return queryLanguageModelAvailability(targetLanguage ?? "en", { api });
	}

	async function createSession(
		createOptions: BuiltinLanguageModelCreateOptions = {},
	): Promise<BuiltinLanguageModelSession> {
		if (api === undefined)
			throw new BuiltinLanguageModelNotReadyError({
				state: "unavailable",
				reason: "browser",
			});

		createOptions.signal?.throwIfAborted();
		const startedGeneration = generation;
		const systemInstruction = [
			...(createOptions.targetLanguage !== undefined
				? [`Translate into ${createOptions.targetLanguage}.`]
				: []),
			...(createOptions.systemInstruction
				? [createOptions.systemInstruction]
				: []),
		].join("\n\n");
		const created = await api.create({
			expectedInputs: options.expectedInputs ?? [
				{ type: "text", languages: ["en", "ja", "es", "de", "fr"] },
				{ type: "image" },
			],
			expectedOutputs: options.expectedOutputs ?? [
				{ type: "text", languages: ["en", "ja", "es", "de", "fr"] },
			],
			...(systemInstruction !== "" && {
				initialPrompts: [
					{
						role: "system",
						content: systemInstruction,
					},
				],
			}),
			...(createOptions.signal !== undefined && {
				signal: createOptions.signal,
			}),
			monitor: (monitor: import("./capability").BuiltinCreateMonitor) =>
				monitorBuiltinDownload(monitor, (progress) => {
					if (createOptions.signal?.aborted) return;
					createOptions.onProgress?.(progress);
					options.onDownloadProgress?.(progress);
				}),
		});
		if (createOptions.signal?.aborted) {
			created.destroy?.();
			createOptions.signal.throwIfAborted();
		}
		if (startedGeneration !== generation) {
			created.destroy?.();
			throw new DOMException(
				"The local model client was destroyed.",
				"AbortError",
			);
		}
		sessions.add(created);
		logger.debug("builtin.language-model.session.created", {
			targetLanguage: createOptions.targetLanguage,
			activeSessions: sessions.size,
		});
		return created;
	}

	async function requestSession(
		promptOptions: BuiltinLanguageModelPromptOptions,
	): Promise<BuiltinLanguageModelSession> {
		promptOptions.signal?.throwIfAborted();
		const targetLanguage = promptOptions.targetLanguage ?? "en";
		const readiness = await availability(targetLanguage);
		promptOptions.signal?.throwIfAborted();
		if (readiness.state !== "available")
			throw new BuiltinLanguageModelNotReadyError(readiness, {
				targetLanguage,
			});
		return createSession({
			targetLanguage,
			systemInstruction: promptOptions.systemInstruction,
			signal: promptOptions.signal,
		});
	}

	async function withSession(
		promptOptions: BuiltinLanguageModelPromptOptions,
		run: (current: BuiltinLanguageModelSession) => Promise<string>,
	): Promise<string> {
		const current = await requestSession(promptOptions);
		const onAbort = () => release(current);
		promptOptions.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			promptOptions.signal?.throwIfAborted();
			const text = await run(current);
			promptOptions.signal?.throwIfAborted();
			if (!sessions.has(current))
				throw new DOMException(
					"The local model session was destroyed.",
					"AbortError",
				);
			return text;
		} finally {
			promptOptions.signal?.removeEventListener("abort", onAbort);
			release(current);
		}
	}

	return {
		availability,
		async create(createOptions = {}) {
			const current = await createSession(createOptions);
			release(current);
		},
		async prompt(input, promptOptions = {}) {
			return withSession(promptOptions, (current) =>
				current.prompt(promptInput(input), {
					signal: promptOptions.signal,
					responseConstraint: promptOptions.responseConstraint,
				}),
			);
		},
		async promptStreaming(input, promptOptions = {}) {
			return withSession(promptOptions, async (current) => {
				let text = "";
				for await (const chunk of current.promptStreaming(promptInput(input), {
					signal: promptOptions.signal,
					responseConstraint: promptOptions.responseConstraint,
				})) {
					promptOptions.signal?.throwIfAborted();
					text += chunk;
					promptOptions.onChunk?.(chunk);
				}
				return text;
			});
		},
		destroy() {
			generation += 1;
			for (const current of sessions) release(current);
		},
	};
}
