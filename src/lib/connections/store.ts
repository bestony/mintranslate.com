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
	activationBlocker,
	applyEdit,
	type Connection,
	type ConnectionEdit,
	canActivate,
	defaultConnectionName,
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
		if (!resolved) return;

		const loadedConnections = loadConnections(resolved);
		setConnections(loadedConnections.value);
		setLoadWarning(loadedConnections.discarded);
		setKeys(loadKeys(resolved));
		setActiveId(loadActiveId(resolved));

		const storedTier = resolved.getItem(TIER_KEY);
		if (storedTier === "advanced" || storedTier === "fast")
			setTierState(storedTier);
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
	}, []);

	const setKey = useCallback((id: string, key: string) => {
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
		},
		[],
	);

	const activate = useCallback<ConnectionStore["activate"]>(
		(id) => {
			const connection = connections.find((entry) => entry.id === id);
			if (!connection) return { ok: false, reason: "连接不存在" };

			if (!canActivate(connection, hasKey(id))) {
				// Reuse the blocker description so the message matches the rule.
				return {
					ok: false,
					reason: activationBlocker(connection, hasKey(id)) ?? "无法启用",
				};
			}

			setActiveId(id);
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

	return {
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
		setTier: setTierState,
		languageUsage,
		noteLanguageUse: (code: string) => {
			if (code === "") return;
			setLanguageUsage((current) => ({
				...current,
				[code]: (current[code] ?? 0) + 1,
			}));
		},
	};
}
