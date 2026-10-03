import { debounce } from "../call-control/debounce";
import {
	createLatestCall,
	type LatestOutcome,
} from "../call-control/latest-call";
import { scrubSecrets } from "../credentials/redact";
import { logger } from "../logger";
import {
	isFeatureAvailable,
	requiresNetwork,
	unavailableReason,
} from "../pwa/offline";
import {
	attributeFailure,
	type FailureAttribution,
	preflightMixedContent,
} from "./attribution";
import { statusOf } from "./error-shape";

/**
 * Pure helpers for discovering models from an OpenAI-compatible endpoint.
 *
 * Model-list responses are intentionally treated as untrusted data. The
 * parser accepts only documented container shapes, ignores entries without a
 * usable identifier, and reports an unknown container as a malformed response.
 * Modality is read only from explicit response fields; model names are never
 * inspected for capability hints.
 */

/** The user-facing reason for a response that is not a model-list shape. */
export const MODEL_LIST_FORMAT_ERROR = "响应格式不符合预期";

/** The result of parsing a model-list response. */
export type ModelListParseResult =
	| { readonly ok: true; readonly models: readonly string[] }
	| { readonly ok: false; readonly reason: typeof MODEL_LIST_FORMAT_ERROR };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive the `/models` URL from a configured endpoint.
 *
 * The endpoint is parsed before it is changed so malformed or empty input is
 * rejected at the boundary. URL parsing also keeps query strings and fragments
 * attached to the configured endpoint while avoiding duplicate path slashes.
 */
export function modelsUrlFor(endpoint: string): string | undefined {
	const value = endpoint.trim();
	if (value === "") return undefined;

	try {
		const url = new URL(value);
		if (url.hostname === "") return undefined;
		const pathname = url.pathname.replace(/\/+$/, "");
		url.pathname = `${pathname}/models`;
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Read a supported model-array container from a response payload. */
function entriesFromPayload(payload: unknown): readonly unknown[] | undefined {
	if (!isRecord(payload)) return undefined;

	if (Array.isArray(payload.data)) return payload.data;
	if (Array.isArray(payload.models)) return payload.models;
	return undefined;
}

/** Read a model identifier from one standard or gateway-specific entry. */
function modelIdFromEntry(entry: unknown): string | undefined {
	if (typeof entry === "string") {
		const id = entry.trim();
		return id === "" ? undefined : id;
	}
	if (!isRecord(entry)) return undefined;

	for (const key of ["id", "model", "model_id", "name"] as const) {
		const value = entry[key];
		if (typeof value !== "string") continue;
		const id = value.trim();
		if (id !== "") return id;
	}
	return undefined;
}

/**
 * Parse model identifiers from a standard `{ data: [...] }` response or the
 * equivalent `{ models: [...] }` gateway shape.
 */
export function parseModelList(payload: unknown): ModelListParseResult {
	const entries = entriesFromPayload(payload);
	if (entries === undefined) {
		return { ok: false, reason: MODEL_LIST_FORMAT_ERROR };
	}

	const models: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const id = modelIdFromEntry(entry);
		if (id === undefined || seen.has(id)) continue;
		seen.add(id);
		models.push(id);
	}

	return { ok: true, models };
}

type ModalityVerdict = { readonly known: boolean; readonly vision: boolean };

function modalityTokens(value: unknown): ModalityVerdict {
	if (Array.isArray(value)) {
		const tokens = value.filter(
			(item): item is string => typeof item === "string",
		);
		return {
			known: true,
			vision: tokens.some((token) => /image|vision/i.test(token)),
		};
	}

	if (typeof value === "string") {
		return { known: true, vision: /image|vision/i.test(value) };
	}

	return { known: false, vision: false };
}

/** Read explicit modality fields from one response object. */
function modalityFromRecord(record: JsonRecord): ModalityVerdict {
	let known = false;
	let vision = false;

	const readBoolean = (key: string): void => {
		if (typeof record[key] !== "boolean") return;
		known = true;
		vision ||= record[key] as boolean;
	};
	const readTokens = (key: string): void => {
		const verdict = modalityTokens(record[key]);
		if (!verdict.known) return;
		known = true;
		vision ||= verdict.vision;
	};

	for (const key of ["vision", "supports_vision", "vision_support"]) {
		readBoolean(key);
	}
	for (const key of [
		"input_modalities",
		"modalities",
		"supported_modalities",
		"input_modality",
		"modality",
	]) {
		readTokens(key);
	}

	for (const nestedKey of ["architecture", "capabilities"]) {
		const nested = record[nestedKey];
		if (!isRecord(nested)) continue;
		const nestedVerdict = modalityFromRecord(nested);
		known ||= nestedVerdict.known;
		vision ||= nestedVerdict.vision;
	}

	return { known, vision };
}

/**
 * Read explicit visual-input support from a model-list response.
 *
 * `undefined` means no recognized modality field was present. A recognized
 * field that contains no image/vision token is a deliberate `false` result.
 */
export function modalitiesFromResponse(payload: unknown): boolean | undefined {
	if (!isRecord(payload)) return undefined;

	let known = false;
	let vision = false;
	const payloadVerdict = modalityFromRecord(payload);
	known ||= payloadVerdict.known;
	vision ||= payloadVerdict.vision;

	const entries = entriesFromPayload(payload);
	if (entries !== undefined) {
		for (const entry of entries) {
			if (!isRecord(entry)) continue;
			const entryVerdict = modalityFromRecord(entry);
			known ||= entryVerdict.known;
			vision ||= entryVerdict.vision;
		}
	}

	return known ? vision : undefined;
}

/** Input needed to request a model list. */
export interface LoadModelsInput {
	readonly endpoint: string;
	readonly apiKey: string;
	/** Injectable connectivity override for tests and non-browser callers. */
	readonly online?: boolean;
	/** Signal supplied by the latest-wins controller. */
	readonly signal?: AbortSignal;
}

/** Minimal response surface used by the request helper and its fake transport. */
export interface ModelListResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

/** Function form of a fetch-compatible transport. */
export type ModelListTransportFunction = (
	input: string,
	init: RequestInit,
) => Promise<ModelListResponse>;

/** Injectable transport; the object form keeps adapters easy to test as well. */
export type ModelListTransport =
	| ModelListTransportFunction
	| { readonly fetch: ModelListTransportFunction };

/** A successful list or an attributed failure. */
export type ModelListResult =
	| {
			readonly ok: true;
			readonly models: readonly string[];
			readonly vision?: boolean;
	  }
	| {
			readonly ok: false;
			readonly attribution: FailureAttribution;
			readonly reason?: "offline";
			/** A short, redacted diagnostic containing no response body. */
			readonly diagnostic?: string;
	  };

/** The debounce window required for explicit model-list queries. */
export const MODEL_LIST_DEBOUNCE_MS = 500;

const defaultTransport: ModelListTransportFunction = (input, init) =>
	globalThis.fetch(input, init);

function browserOnline(): boolean {
	return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

function offlineResult(): ModelListResult {
	return {
		ok: false,
		reason: "offline",
		attribution: {
			type: "unknown",
			summary:
				unavailableReason("modelList", false) ??
				"当前处于离线状态，无法获取模型列表。",
		},
	};
}

function failureResult(
	attribution: FailureAttribution,
	status: number | undefined,
	error: unknown,
	apiKey: string,
): ModelListResult {
	// Do not expose a response body. A redacted error name is enough to distinguish
	// an opaque browser failure in diagnostics without leaking endpoint content.
	const diagnostic =
		status === undefined
			? scrubSecrets(
					error instanceof Error ? error.name : "RequestError",
					apiKey.trim() === "" ? [] : [apiKey],
				)
			: `HTTP ${status}`;

	logger.warn("model-list.failed", {
		attribution: attribution.type,
		...(status !== undefined && { status }),
	});

	return {
		ok: false,
		attribution,
		...(diagnostic !== "" && { diagnostic }),
	};
}

function transportFor(
	transport: ModelListTransport,
): ModelListTransportFunction {
	return typeof transport === "function" ? transport : transport.fetch;
}

/**
 * Fetch and parse one OpenAI-compatible model list.
 *
 * This function only performs the direct `/models` probe. Provider adapters and
 * the translation model caller are deliberately not involved.
 */
export async function loadModels(
	input: LoadModelsInput,
	transport: ModelListTransport = defaultTransport,
): Promise<ModelListResult> {
	const online = input.online ?? browserOnline();
	if (
		requiresNetwork("modelList") &&
		!isFeatureAvailable("modelList", online)
	) {
		return offlineResult();
	}

	const url = modelsUrlFor(input.endpoint);
	if (url === undefined) {
		return failureResult(
			attributeFailure({ malformedResponse: true }),
			undefined,
			undefined,
			input.apiKey,
		);
	}

	const blocked = preflightMixedContent({
		isSecureContext: globalThis.isSecureContext === true,
		pageUrl: typeof location === "undefined" ? undefined : location.href,
		endpoint: input.endpoint,
	});
	if (blocked !== undefined) {
		return failureResult(blocked, undefined, undefined, input.apiKey);
	}

	const key = input.apiKey.trim();
	const headers: Record<string, string> = {
		Accept: "application/json",
		...(key !== "" && { Authorization: `Bearer ${key}` }),
	};

	try {
		const response = await transportFor(transport)(url, {
			method: "GET",
			headers,
			signal: input.signal,
		});
		const status =
			typeof response.status === "number" ? response.status : undefined;
		const failed =
			response.ok === false ||
			(status !== undefined && (status < 200 || status >= 300));
		if (failed) {
			return failureResult(
				attributeFailure({ httpStatus: status }),
				status,
				undefined,
				input.apiKey,
			);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			return failureResult(
				attributeFailure({
					httpStatus: status,
					error,
					malformedResponse: true,
				}),
				status,
				error,
				input.apiKey,
			);
		}

		const parsed = parseModelList(payload);
		if (!parsed.ok) {
			return failureResult(
				attributeFailure({
					httpStatus: status,
					malformedResponse: true,
				}),
				status,
				undefined,
				input.apiKey,
			);
		}

		const vision = modalitiesFromResponse(payload);
		logger.info("model-list.success", { modelCount: parsed.models.length });
		return {
			ok: true,
			models: parsed.models,
			...(vision !== undefined && { vision }),
		};
	} catch (error) {
		const status = statusOf(error);
		return failureResult(
			attributeFailure({ httpStatus: status, error }),
			status,
			error,
			input.apiKey,
		);
	}
}

/** Controller outcome: stale work is explicitly ignored by the caller. */
export type ModelListControllerOutcome = LatestOutcome<ModelListResult>;

/** Injectable seams for the debounced latest-wins controller. */
export interface ModelListControllerOptions {
	readonly transport?: ModelListTransport;
	readonly debounceMs?: number;
	readonly isOnline?: () => boolean;
}

/** Public model-list controller used by the settings form. */
export interface ModelListController {
	request(
		input: Omit<LoadModelsInput, "online" | "signal">,
	): Promise<ModelListControllerOutcome>;
	cancel(): void;
	pending(): boolean;
}

/**
 * Compose the existing debounce and latest-wins primitives for model queries.
 *
 * The first promise in a debounce window resolves as `superseded`, so callers
 * never retain a pending promise for a request that was replaced before it ran.
 */
export function createModelListController(
	options: ModelListControllerOptions = {},
): ModelListController {
	const latest = createLatestCall();
	const transport = options.transport ?? defaultTransport;
	const waitMs = options.debounceMs ?? MODEL_LIST_DEBOUNCE_MS;
	let pendingRequest:
		| {
				readonly input: Omit<LoadModelsInput, "online" | "signal">;
				readonly resolve: (outcome: ModelListControllerOutcome) => void;
		  }
		| undefined;

	const schedule = debounce(() => {
		const request = pendingRequest;
		pendingRequest = undefined;
		if (request === undefined) return;

		void latest
			.run((signal) =>
				loadModels({ ...request.input, signal, online: true }, transport),
			)
			.then(request.resolve);
	}, waitMs);

	return {
		request(input) {
			const online = options.isOnline?.() ?? browserOnline();
			if (
				requiresNetwork("modelList") &&
				!isFeatureAvailable("modelList", online)
			) {
				return Promise.resolve({ kind: "result", value: offlineResult() });
			}

			pendingRequest?.resolve({ kind: "superseded" });
			return new Promise((resolve) => {
				pendingRequest = { input, resolve };
				schedule();
			});
		},
		cancel() {
			schedule.cancel();
			pendingRequest?.resolve({ kind: "superseded" });
			pendingRequest = undefined;
			latest.cancel();
		},
		pending() {
			return schedule.pending() || latest.busy();
		},
	};
}
