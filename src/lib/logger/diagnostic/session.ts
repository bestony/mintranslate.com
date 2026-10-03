/**
 * Diagnostic logging session management.
 *
 * Coordinates 5-minute auto-expiry, cross-tab synchronization via localStorage,
 * and reactive notifications when session state changes.
 */

export const DIAGNOSTIC_SESSION_STORAGE_KEY =
	"mintranslate.diagnostic-session.v1";

/** Default auto-stop duration: 5 minutes. */
export const DEFAULT_DIAGNOSTIC_DURATION_MS = 5 * 60 * 1000;

export interface StoredSession {
	readonly startedAt: number;
	readonly expiresAt: number;
}

export interface DiagnosticSessionState {
	readonly active: boolean;
	readonly startedAt?: number;
	readonly expiresAt?: number;
	readonly remainingMs: number;
}

export interface MinimalStorage {
	getItem(key: string): string | null;
	setItem?(key: string, value: string): void;
	removeItem?(key: string): void;
}

/** Fallback safe storage accessor. */
function currentStorage(): MinimalStorage | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

/** Parse stored session or return undefined if absent or invalid. */
export function readStoredSession(
	storage: MinimalStorage | undefined = currentStorage(),
): StoredSession | undefined {
	if (!storage) return undefined;

	try {
		const raw = storage.getItem(DIAGNOSTIC_SESSION_STORAGE_KEY);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as Partial<StoredSession>;
		if (
			typeof parsed.startedAt === "number" &&
			typeof parsed.expiresAt === "number"
		) {
			return {
				startedAt: parsed.startedAt,
				expiresAt: parsed.expiresAt,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Check whether diagnostic logging is currently active. */
export function isDiagnosticLoggingActive(
	storage: MinimalStorage | undefined = currentStorage(),
	now: number = Date.now(),
): boolean {
	const session = readStoredSession(storage);
	if (!session) return false;
	return now < session.expiresAt;
}

/** Get full session status with remaining milliseconds. */
export function getDiagnosticSession(
	storage: MinimalStorage | undefined = currentStorage(),
	now: number = Date.now(),
): DiagnosticSessionState {
	const session = readStoredSession(storage);
	if (!session || now >= session.expiresAt) {
		return {
			active: false,
			remainingMs: 0,
		};
	}

	return {
		active: true,
		startedAt: session.startedAt,
		expiresAt: session.expiresAt,
		remainingMs: Math.max(0, session.expiresAt - now),
	};
}

type SessionChangeListener = (state: DiagnosticSessionState) => void;
const listeners = new Set<SessionChangeListener>();

function notifyListeners(): void {
	const state = getDiagnosticSession();
	for (const listener of listeners) {
		try {
			listener(state);
		} catch {
			// Ignore listener errors
		}
	}
}

/** Start a 5-minute diagnostic logging session. */
export function startDiagnosticSession(
	durationMs: number = DEFAULT_DIAGNOSTIC_DURATION_MS,
	storage: MinimalStorage | undefined = currentStorage(),
	now: number = Date.now(),
): DiagnosticSessionState {
	const startedAt = now;
	const expiresAt = now + Math.max(1000, durationMs);
	const session: StoredSession = { startedAt, expiresAt };

	if (storage) {
		try {
			storage.setItem?.(
				DIAGNOSTIC_SESSION_STORAGE_KEY,
				JSON.stringify(session),
			);
		} catch {
			// Storage quota / private mode guard
		}
	}

	notifyListeners();

	return {
		active: true,
		startedAt,
		expiresAt,
		remainingMs: expiresAt - now,
	};
}

/** Stop the active diagnostic logging session. */
export function stopDiagnosticSession(
	storage: MinimalStorage | undefined = currentStorage(),
): void {
	if (storage) {
		try {
			storage.removeItem?.(DIAGNOSTIC_SESSION_STORAGE_KEY);
		} catch {
			// Storage quota / private mode guard
		}
	}

	notifyListeners();
}

/**
 * Subscribe to session state changes.
 * Listens to programmatic updates and cross-tab window storage events.
 */
export function onDiagnosticSessionChange(
	listener: SessionChangeListener,
): () => void {
	listeners.add(listener);

	function onWindowStorage(event: StorageEvent) {
		if (event.key === DIAGNOSTIC_SESSION_STORAGE_KEY) {
			listener(getDiagnosticSession());
		}
	}

	if (typeof window !== "undefined") {
		window.addEventListener("storage", onWindowStorage);
	}

	return () => {
		listeners.delete(listener);
		if (typeof window !== "undefined") {
			window.removeEventListener("storage", onWindowStorage);
		}
	};
}
