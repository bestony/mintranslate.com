/**
 * Persistence for connections and API keys.
 *
 * Two stores, deliberately separate:
 *
 * - `CONNECTIONS_KEY` holds connection configuration. It is what "export
 *   configuration" reads, so it must never contain a key.
 * - `KEYS_KEY` holds API keys, addressable by connection id.
 *
 * Keeping them apart makes "export without keys" a property of the data layout
 * rather than of a filter that could be forgotten, and makes "clear all keys" a
 * single removal instead of a sweep. See design.md D3.
 *
 * Serialization is pure and defensive: anything read back from storage is
 * untrusted (a user, another tab, or an older version may have written it), so
 * every field is validated and unknown shapes are dropped rather than trusted.
 */

import {
	CONNECTION_STATUSES,
	type Connection,
	isBuiltinConnectionId,
	isProviderId,
	type ProviderId,
} from "./model";

/** Storage slot for connection configuration (never contains a key). */
export const CONNECTIONS_KEY = "mintranslate.connections.v1";

/** Storage slot for API keys, keyed by connection id. */
export const KEYS_KEY = "mintranslate.credentials.v1";

/** Storage slot for the active connection id. */
export const ACTIVE_KEY = "mintranslate.active-connection.v1";

/** Storage slot for language usage counts, which order the quick-switch chips. */
export const LANGUAGE_USAGE_KEY = "mintranslate.language-usage.v1";

/** Storage slot for the selected tier. */
export const TIER_KEY = "mintranslate.tier.v1";

/** Storage slot for the selected prompt style. */
export const STYLE_KEY = "mintranslate.prompt-style.v1";

/** Storage slot for the custom style instruction. */
export const CUSTOM_INSTRUCTION_KEY = "mintranslate.custom-instruction.v1";

/** Minimal key/value surface, satisfied by `localStorage` and by test doubles. */
export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** Result of reading connections, so callers can distinguish corrupt from empty. */
export interface LoadResult<T> {
	readonly value: T;
	/** Present when stored data was unusable and had to be discarded. */
	readonly discarded?: string;
}

/** Validate one stored connection, returning `undefined` when unusable. */
function parseConnection(raw: unknown): Connection | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;

	if (typeof value.id !== "string" || value.id === "") return undefined;
	if (!isProviderId(value.provider)) return undefined;
	if (typeof value.endpoint !== "string") return undefined;
	if (typeof value.model !== "string") return undefined;
	if (typeof value.name !== "string") return undefined;
	if (typeof value.status !== "string") return undefined;
	if (!(CONNECTION_STATUSES as readonly string[]).includes(value.status))
		return undefined;

	const capabilities = value.capabilities as
		| Record<string, unknown>
		| undefined;

	return {
		id: value.id,
		name: value.name,
		provider: value.provider as ProviderId,
		endpoint: value.endpoint,
		model: value.model,
		capabilities: {
			text: capabilities?.text === true,
			vision: capabilities?.vision === true,
		},
		status: value.status as Connection["status"],
		...(typeof value.statusDetail === "string" && {
			statusDetail: value.statusDetail,
		}),
		...(value.tier === "advanced" || value.tier === "fast"
			? { tier: value.tier }
			: {}),
		createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
	};
}

/**
 * Serialize connections for storage.
 *
 * Written explicitly field by field rather than as a spread, so a key that
 * somehow reached this object cannot be persisted by accident.
 */
export function serializeConnections(
	connections: readonly Connection[],
): string {
	return JSON.stringify(
		connections.map((connection) => ({
			id: connection.id,
			name: connection.name,
			provider: connection.provider,
			endpoint: connection.endpoint,
			model: connection.model,
			capabilities: {
				text: connection.capabilities.text,
				vision: connection.capabilities.vision,
			},
			status: connection.status,
			...(connection.statusDetail !== undefined && {
				statusDetail: connection.statusDetail,
			}),
			...(connection.tier !== undefined && { tier: connection.tier }),
			createdAt: connection.createdAt,
			updatedAt: connection.updatedAt,
		})),
	);
}

/** Parse stored connections, discarding anything that does not validate. */
export function deserializeConnections(
	raw: string | null,
): LoadResult<Connection[]> {
	if (raw === null || raw.trim() === "") return { value: [] };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { value: [], discarded: "连接配置无法解析，已重置。" };
	}

	if (!Array.isArray(parsed)) {
		return { value: [], discarded: "连接配置格式不正确，已重置。" };
	}

	const connections: Connection[] = [];
	let discardedCount = 0;
	for (const entry of parsed) {
		const connection = parseConnection(entry);
		if (connection) connections.push(connection);
		else discardedCount += 1;
	}

	return discardedCount > 0
		? {
				value: connections,
				discarded: `已跳过 ${discardedCount} 条无法识别的连接配置。`,
			}
		: { value: connections };
}

/** Serialize the key map. */
export function serializeKeys(keys: Readonly<Record<string, string>>): string {
	const filtered = Object.fromEntries(
		Object.entries(keys).filter(([id]) => !isBuiltinConnectionId(id)),
	);
	return JSON.stringify(filtered);
}

/** Parse the stored key map, dropping non-string values. */
export function deserializeKeys(raw: string | null): Record<string, string> {
	if (raw === null || raw.trim() === "") return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return {};

	const keys: Record<string, string> = {};
	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "string" && !isBuiltinConnectionId(id))
			keys[id] = value;
	}
	return keys;
}

/** Read connections from a store. */
export function loadConnections(
	store: KeyValueStore,
): LoadResult<Connection[]> {
	return deserializeConnections(store.getItem(CONNECTIONS_KEY));
}

/** Write connections to a store. */
export function saveConnections(
	store: KeyValueStore,
	connections: readonly Connection[],
): void {
	store.setItem(CONNECTIONS_KEY, serializeConnections(connections));
}

/** Read the key map from a store. */
export function loadKeys(store: KeyValueStore): Record<string, string> {
	return deserializeKeys(store.getItem(KEYS_KEY));
}

/** Write the key map to a store. */
export function saveKeys(
	store: KeyValueStore,
	keys: Readonly<Record<string, string>>,
): void {
	store.setItem(KEYS_KEY, serializeKeys(keys));
}

/** Read the active connection id. */
export function loadActiveId(store: KeyValueStore): string | null {
	const value = store.getItem(ACTIVE_KEY);
	return value === null || value === "" ? null : value;
}

/** Write the active connection id, or clear it with `null`. */
export function saveActiveId(store: KeyValueStore, id: string | null): void {
	if (id === null) store.removeItem(ACTIVE_KEY);
	else store.setItem(ACTIVE_KEY, id);
}

/**
 * Export connection configuration for the user to keep.
 *
 * Never includes keys: it reads the connections slot only. The `includeKeys`
 * path takes an explicit key map so the caller must opt in deliberately, and
 * the confirmation step lives in the UI.
 */
export function exportConfiguration(
	connections: readonly Connection[],
	includeKeys: boolean,
	keys?: Readonly<Record<string, string>>,
): string {
	const payload: Record<string, unknown> = {
		version: 1,
		exportedAt: new Date().toISOString(),
		connections: JSON.parse(serializeConnections(connections)),
	};

	if (includeKeys) {
		payload.credentials = { ...(keys ?? {}) };
	}

	return JSON.stringify(payload, null, 2);
}
