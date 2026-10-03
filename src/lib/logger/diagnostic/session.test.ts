import { describe, expect, it } from "vitest";

import {
	DEFAULT_DIAGNOSTIC_DURATION_MS,
	DIAGNOSTIC_SESSION_STORAGE_KEY,
	getDiagnosticSession,
	isDiagnosticLoggingActive,
	startDiagnosticSession,
	stopDiagnosticSession,
} from "./session";

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
	const map = new Map<string, string>(Object.entries(initial));
	return {
		get length() {
			return map.size;
		},
		clear: () => map.clear(),
		getItem: (key: string) => map.get(key) ?? null,
		key: (index: number) => Array.from(map.keys())[index] ?? null,
		removeItem: (key: string) => map.delete(key),
		setItem: (key: string, value: string) => map.set(key, value),
	};
}

describe("diagnostic session", () => {
	it("returns inactive when no session is stored", () => {
		const storage = createMemoryStorage();
		expect(isDiagnosticLoggingActive(storage)).toBe(false);

		const session = getDiagnosticSession(storage);
		expect(session.active).toBe(false);
		expect(session.remainingMs).toBe(0);
	});

	it("starts a 5-minute session and calculates remaining time", () => {
		const storage = createMemoryStorage();
		const now = 1000000;

		const started = startDiagnosticSession(
			DEFAULT_DIAGNOSTIC_DURATION_MS,
			storage,
			now,
		);
		expect(started.active).toBe(true);
		expect(started.startedAt).toBe(now);
		expect(started.expiresAt).toBe(now + 300000);
		expect(started.remainingMs).toBe(300000);

		// Within 5 minutes
		expect(isDiagnosticLoggingActive(storage, now + 60000)).toBe(true);
		const current = getDiagnosticSession(storage, now + 60000);
		expect(current.active).toBe(true);
		expect(current.remainingMs).toBe(240000);

		// After 5 minutes (auto-expiry)
		expect(isDiagnosticLoggingActive(storage, now + 300001)).toBe(false);
		const expired = getDiagnosticSession(storage, now + 300001);
		expect(expired.active).toBe(false);
		expect(expired.remainingMs).toBe(0);
	});

	it("stops an active session", () => {
		const storage = createMemoryStorage();
		startDiagnosticSession(300000, storage, 1000);
		expect(isDiagnosticLoggingActive(storage, 2000)).toBe(true);

		stopDiagnosticSession(storage);
		expect(isDiagnosticLoggingActive(storage, 2000)).toBe(false);
		expect(storage.getItem(DIAGNOSTIC_SESSION_STORAGE_KEY)).toBeNull();
	});
});
