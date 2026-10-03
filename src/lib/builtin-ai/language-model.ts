/**
 * Main-thread wrapper for Chrome's Prompt API (`LanguageModel`).
 *
 * The wrapper owns browser session creation and destruction. Callers provide
 * already-processed image bytes and an explicit response constraint; no image
 * is persisted or sent through an external adapter.
 */

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
	let session: BuiltinLanguageModelSession | undefined;

	async function availability(
		targetLanguage?: string,
	): Promise<BuiltinReadiness> {
		if (api === undefined) return { state: "unavailable", reason: "browser" };
		return queryLanguageModelAvailability(targetLanguage ?? "en", { api });
	}

	async function create(
		createOptions: BuiltinLanguageModelCreateOptions = {},
	): Promise<void> {
		if (api === undefined)
			throw new BuiltinLanguageModelNotReadyError({
				state: "unavailable",
				reason: "browser",
			});

		createOptions.signal?.throwIfAborted();
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
		session?.destroy?.();
		session = created;
	}

	async function ensureSession(
		promptOptions: BuiltinLanguageModelPromptOptions,
	): Promise<BuiltinLanguageModelSession> {
		promptOptions.signal?.throwIfAborted();
		if (session !== undefined) return session;
		const targetLanguage = promptOptions.targetLanguage ?? "en";
		const readiness = await availability(targetLanguage);
		promptOptions.signal?.throwIfAborted();
		if (readiness.state !== "available")
			throw new BuiltinLanguageModelNotReadyError(readiness, {
				targetLanguage,
			});
		await create({
			targetLanguage,
			systemInstruction: promptOptions.systemInstruction,
			signal: promptOptions.signal,
		});
		if (session === undefined)
			throw new BuiltinLanguageModelNotReadyError({
				state: "unavailable",
				reason: "unknown",
			});
		return session;
	}

	return {
		availability,
		create,
		async prompt(input, promptOptions = {}) {
			const current = await ensureSession(promptOptions);
			return current.prompt(promptInput(input), {
				signal: promptOptions.signal,
				responseConstraint: promptOptions.responseConstraint,
			});
		},
		async promptStreaming(input, promptOptions = {}) {
			const current = await ensureSession(promptOptions);
			let text = "";
			for await (const chunk of current.promptStreaming(promptInput(input), {
				signal: promptOptions.signal,
				responseConstraint: promptOptions.responseConstraint,
			})) {
				text += chunk;
			}
			return text;
		},
		destroy() {
			session?.destroy?.();
			session = undefined;
		},
	};
}
