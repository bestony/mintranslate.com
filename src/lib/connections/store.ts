/**
 * Connection store.
 *
 * Owns the saved connections, the API keys, the active connection and the
 * selected tier. Keys are held in a separate map and are only ever read through
 * `keyFor`, so no code path can accidentally serialize a key alongside a
 * connection (design.md D3).
 *
 * The store is the single place that enforces "only a tested connection may be
 * active" (design.md D4). Callers get a reason back instead of a boolean so the
 * UI can explain the refusal.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type BuiltinApiScope,
	type BuiltinCapabilityDetection,
	type BuiltinReadiness,
	deriveBuiltinConnectionStatus,
	detectBuiltinCapabilities,
	queryLanguageModelAvailability,
	queryTranslatorAvailability,
} from "../builtin-ai/capability";
import { logger } from "../logger";
import {
	activationBlocker,
	applyEdit,
	BUILTIN_CONNECTION_IDS,
	type Connection,
	type ConnectionEdit,
	canActivate,
	defaultConnectionName,
	isBuiltinConnectionId,
	isBuiltinProvider,
	type ModelTier,
	type ProviderId,
} from "./model";
import { presetFor } from "./presets";
import {
	type KeyValueStore,
	LANGUAGE_USAGE_KEY,
	loadActiveId,
	loadConnections,
	loadKeys,
	saveActiveId,
	saveConnections,
	saveKeys,
	TIER_KEY,
} from "./storage";

/** Reactive browser storage, or `undefined` during prerender / tests. */
function browserStore(): KeyValueStore | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		// Storage can be unavailable (private mode, blocked cookies). The app
		// must still run; it just cannot persist.
		return undefined;
	}
}

/** Generate an identifier for a new connection. */
function newId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto)
		return crypto.randomUUID();
	return `conn-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export interface ConnectionStoreState {
	readonly connections: readonly Connection[];
	readonly activeId: string | null;
	readonly tier: ModelTier;
	/** Set when stored data had to be discarded, for a one-time notice. */
	readonly loadWarning?: string;
}

export interface ConnectionStore extends ConnectionStoreState {
	/** The active connection, if it still exists and is activatable. */
	readonly activeConnection: Connection | undefined;
	/** Key for a connection id. Empty string when unset. */
	keyFor(id: string): string;
	/** Whether a connection has a key; used for activation gating. */
	hasKey(id: string): boolean;
	/** Create a connection from a provider preset. Returns the new id. */
	createFromPreset(provider: ProviderId): string;
	/** Edit fields; invalidates the test when endpoint or model changes. */
	update(id: string, edit: ConnectionEdit): void;
	/** Replace a connection's key. */
	setKey(id: string, key: string): void;
	/** Remove every stored key. */
	clearAllKeys(): void;
	/** Move a connection to a status, recording a failure reason. */
	setStatus(id: string, status: Connection["status"], detail?: string): void;
	/** Make a connection active. Rejected when it cannot be activated. */
	activate(id: string): { ok: true } | { ok: false; reason: string };
	/** Delete a connection and its key. */
	remove(id: string): void;
	setTier(tier: ModelTier): void;
	/** Connections that passed their test, for tier resolution. */
	readonly usableConnections: readonly Connection[];
	/** How often each language code has been used, for the quick-switch chips. */
	readonly languageUsage: Readonly<Record<string, number>>;
	/** Record a language use so the quick chips follow the user's habits. */
	noteLanguageUse(code: string): void;
}

/** Capability support used when deriving the fixed built-in connections. */
export interface BuiltinConnectionSupport {
	readonly translator: boolean;
	readonly multimodal: boolean;
}

/** Optional readiness results used to show download and device details. */
export interface BuiltinConnectionReadiness {
	readonly translator?: BuiltinReadiness;
	readonly multimodal?: BuiltinReadiness;
}

/** Translator requires both its translator and local detector APIs. */
export function builtinConnectionSupport(
	detection: BuiltinCapabilityDetection,
): BuiltinConnectionSupport {
	return {
		translator: detection.translator && detection.languageDetector,
		multimodal: detection.languageModel,
	};
}

const BUILTIN_CONNECTION_DEFINITIONS = {
	"builtin-translator": {
		name: "内置翻译（仅文本）",
		capabilities: { text: true, vision: false },
		kind: "translator",
	},
	"builtin-multimodal": {
		name: "内置多模态（文本与图片）",
		capabilities: { text: true, vision: true },
		kind: "multimodal",
	},
} as const;

/**
 * Add supported built-in connections and remove unsupported fixed ids.
 *
 * The map keeps this operation linear even when a user has many BYOK
 * connections. Existing tier assignments and timestamps are preserved.
 */
export function seedBuiltinConnections(
	connections: readonly Connection[],
	support: BuiltinConnectionSupport,
	now = Date.now(),
	readiness: BuiltinConnectionReadiness = {},
): Connection[] {
	const existing = new Map(
		connections.map((connection) => [connection.id, connection]),
	);
	const next = connections.filter((connection) => {
		return !isBuiltinConnectionId(connection.id);
	});

	for (const id of BUILTIN_CONNECTION_IDS) {
		const kind = BUILTIN_CONNECTION_DEFINITIONS[id].kind;
		if (!support[kind]) continue;

		const definition = BUILTIN_CONNECTION_DEFINITIONS[id];
		const current = existing.get(id);
		const state = readiness[kind];
		const derived = state
			? deriveBuiltinConnectionStatus(state)
			: { status: "ok" as const };

		next.push({
			...(current ?? {
				id,
				createdAt: now,
				updatedAt: now,
			}),
			name: definition.name,
			provider: id,
			endpoint: "",
			model: "",
			capabilities: definition.capabilities,
			status: derived.status,
			...(derived.statusDetail !== undefined && {
				statusDetail: derived.statusDetail,
			}),
			...(derived.statusDetail === undefined && { statusDetail: undefined }),
			updatedAt:
				current?.status === derived.status &&
				current?.statusDetail === derived.statusDetail
					? current.updatedAt
					: now,
		});
	}

	return next;
}

/** Strip any legacy or manually inserted keys for fixed built-in ids. */
export function stripBuiltinKeys(
	keys: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(keys).filter(([id]) => !isBuiltinConnectionId(id)),
	);
}

/**
 * Load persisted state once, then keep it in React state.
 *
 * Reads happen in an effect rather than during render so the prerendered shell
 * and the first client render agree (there is no storage on the server).
 */
export function useConnectionStore(): ConnectionStore {
	const [store, setStore] = useState<KeyValueStore | undefined>(undefined);
	const [connections, setConnections] = useState<readonly Connection[]>([]);
	const [keys, setKeys] = useState<Record<string, string>>({});
	const [activeId, setActiveId] = useState<string | null>(null);
	const [tier, setTierState] = useState<ModelTier>("advanced");
	const [loadWarning, setLoadWarning] = useState<string | undefined>(undefined);
	const [languageUsage, setLanguageUsage] = useState<Record<string, number>>(
		{},
	);

	useEffect(() => {
		const resolved = browserStore();
		setStore(resolved);
		const detection = detectBuiltinCapabilities();
		const support = builtinConnectionSupport(detection);
		if (!resolved) {
			setConnections(seedBuiltinConnections([], support));
			return;
		}

		const loadedConnections = loadConnections(resolved);
		const seeded = seedBuiltinConnections(loadedConnections.value, support);
		setConnections(seeded);
		setLoadWarning(loadedConnections.discarded);
		setKeys(stripBuiltinKeys(loadKeys(resolved)));
		const loadedActiveId = loadActiveId(resolved);
		setActiveId(
			loadedActiveId !== null && seeded.some(({ id }) => id === loadedActiveId)
				? loadedActiveId
				: null,
		);

		const storedTier = resolved.getItem(TIER_KEY);
		if (storedTier === "advanced" || storedTier === "fast")
			setTierState(storedTier);

		let cancelled = false;
		void Promise.all([
			support.translator
				? queryTranslatorAvailability("en", "zh", {
						scope: globalThis as BuiltinApiScope,
					})
				: Promise.resolve(undefined),
			support.multimodal
				? queryLanguageModelAvailability("en", {
						scope: globalThis as BuiltinApiScope,
					})
				: Promise.resolve(undefined),
		]).then(([translator, multimodal]) => {
			if (cancelled) return;
			setConnections((current) =>
				seedBuiltinConnections(current, support, Date.now(), {
					...(translator !== undefined && { translator }),
					...(multimodal !== undefined && { multimodal }),
				}),
			);
		});

		return () => {
			cancelled = true;
		};
	}, []);

	// Persist on change. Each effect writes only its own slot.
	useEffect(() => {
		if (store) saveConnections(store, connections);
	}, [store, connections]);

	useEffect(() => {
		if (store) saveKeys(store, keys);
	}, [store, keys]);

	useEffect(() => {
		if (store) saveActiveId(store, activeId);
	}, [store, activeId]);

	useEffect(() => {
		if (store) store.setItem(TIER_KEY, tier);
	}, [store, tier]);

	useEffect(() => {
		if (store) store.setItem(LANGUAGE_USAGE_KEY, JSON.stringify(languageUsage));
	}, [store, languageUsage]);

	const keyFor = useCallback((id: string) => keys[id] ?? "", [keys]);
	const hasKey = useCallback(
		(id: string) => (keys[id] ?? "").trim() !== "",
		[keys],
	);

	const createFromPreset = useCallback((provider: ProviderId) => {
		if (isBuiltinProvider(provider)) {
			logger.warn("connection.builtin_create_ignored", { provider });
			return provider;
		}
		const now = Date.now();
		const id = newId();
		const preset = presetFor(provider);
		const label = preset?.label ?? "自定义（OpenAI 兼容）";

		setConnections((current) => [
			...current,
			{
				id,
				name: defaultConnectionName(label, preset?.models[0] ?? ""),
				provider,
				endpoint: preset?.endpoint ?? "",
				model: preset?.models[0] ?? "",
				capabilities: preset?.capabilities ?? { text: true, vision: false },
				status: "untested",
				createdAt: now,
				updatedAt: now,
			},
		]);

		logger.info("connection.created", {
			id,
			provider,
			model: preset?.models[0] ?? "",
		});

		return id;
	}, []);

	const update = useCallback<ConnectionStore["update"]>((id, edit) => {
		setConnections((current) =>
			current.map((connection) =>
				connection.id === id
					? applyEdit(connection, edit, Date.now())
					: connection,
			),
		);
		logger.info("connection.updated", {
			id,
			changedFields: Object.keys(edit),
		});
	}, []);

	const setKey = useCallback((id: string, key: string) => {
		if (isBuiltinConnectionId(id)) {
			logger.warn("connection.builtin_key_ignored", { id });
			return;
		}
		setKeys((current) => {
			const next = { ...current };
			if (key === "") delete next[id];
			else next[id] = key;
			return next;
		});

		// Changing the key invalidates a passed test: the recorded result
		// described a different credential.
		setConnections((current) =>
			current.map((connection) =>
				connection.id === id
					? {
							...connection,
							status: "untested",
							statusDetail: undefined,
							updatedAt: Date.now(),
						}
					: connection,
			),
		);
		logger.info("connection.key_updated", {
			id,
			configured: key.trim() !== "",
		});
	}, []);

	const clearAllKeys = useCallback(() => {
		setKeys({});
		// Every connection loses its credential, so no test result survives.
		setConnections((current) =>
			current.map((connection) => ({
				...connection,
				status: "untested" as const,
				statusDetail: undefined,
				updatedAt: Date.now(),
			})),
		);
		logger.warn("connection.keys_cleared");
	}, []);

	const setStatus = useCallback<ConnectionStore["setStatus"]>(
		(id, status, detail) => {
			setConnections((current) =>
				current.map((connection) =>
					connection.id === id
						? {
								...connection,
								status,
								statusDetail: detail,
								updatedAt: Date.now(),
							}
						: connection,
				),
			);
			logger.info("connection.status_changed", { id, status, detail });
		},
		[],
	);

	const activate = useCallback<ConnectionStore["activate"]>(
		(id) => {
			const connection = connections.find((entry) => entry.id === id);
			if (!connection) {
				logger.warn("connection.activation_failed", {
					id,
					reason: "连接不存在",
				});
				return { ok: false, reason: "连接不存在" };
			}

			if (!canActivate(connection, hasKey(id))) {
				const reason = activationBlocker(connection, hasKey(id)) ?? "无法启用";
				logger.warn("connection.activation_failed", { id, reason });
				return {
					ok: false,
					reason,
				};
			}

			setActiveId(id);
			logger.info("connection.activated", {
				id,
				name: connection.name,
				model: connection.model,
			});
			return { ok: true };
		},
		[connections, hasKey],
	);

	const remove = useCallback((id: string) => {
		setConnections((current) =>
			current.filter((connection) => connection.id !== id),
		);
		setKeys((current) => {
			const next = { ...current };
			delete next[id];
			return next;
		});
		// Deleting the active connection clears the selection rather than
		// silently promoting another one.
		setActiveId((current) => (current === id ? null : current));
		logger.info("connection.removed", { id });
	}, []);

	const availableIds = useMemo(
		() => new Set(connections.map((connection) => connection.id)),
		[connections],
	);

	// A persisted active id may point at a connection that no longer exists.
	const effectiveActiveId =
		activeId !== null && availableIds.has(activeId) ? activeId : null;

	const activeConnection = useMemo(
		() => connections.find((connection) => connection.id === effectiveActiveId),
		[connections, effectiveActiveId],
	);

	const usableConnections = useMemo(
		() => connections.filter((connection) => connection.status === "ok"),
		[connections],
	);

	const setTier = useCallback((nextTier: ModelTier) => {
		setTierState(nextTier);
		logger.info("connection.tier_changed", { tier: nextTier });
	}, []);

	const noteLanguageUse = useCallback((code: string) => {
		if (code === "") return;
		setLanguageUsage((current) => ({
			...current,
			[code]: (current[code] ?? 0) + 1,
		}));
	}, []);

	// Consumers put the store in hook dependency lists, so its identity must
	// change only when its contents do, not on every render.
	return useMemo(
		() => ({
			connections,
			activeId: effectiveActiveId,
			tier,
			loadWarning,
			activeConnection,
			usableConnections,
			keyFor,
			hasKey,
			createFromPreset,
			update,
			setKey,
			clearAllKeys,
			setStatus,
			activate,
			remove,
			setTier,
			languageUsage,
			noteLanguageUse,
		}),
		[
			connections,
			effectiveActiveId,
			tier,
			loadWarning,
			activeConnection,
			usableConnections,
			keyFor,
			hasKey,
			createFromPreset,
			update,
			setKey,
			clearAllKeys,
			setStatus,
			activate,
			remove,
			setTier,
			languageUsage,
			noteLanguageUse,
		],
	);
}
