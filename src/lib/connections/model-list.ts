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
