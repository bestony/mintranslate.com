import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LogRecord } from "../index";
import { countLogs, openLogDatabase, queryLogsByRange } from "./db";
import {
	DEFAULT_DIAGNOSTIC_DURATION_MS,
	DiagnosticLogSink,
	startDiagnosticSession,
	stopDiagnosticSession,
} from "./index";

function createMemoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => Array.from(values.keys())[index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
}

function record(timestamp: number): LogRecord {
	return {
		level: "info",
		event: `test.${timestamp}`,
		timestamp,
		fields: {},
	};
}

describe("diagnostic log sink", () => {
	afterEach(() => {
		stopDiagnosticSession();
		vi.unstubAllGlobals();
	});

	it("buffers active-session logs and prunes the oldest records", async () => {
		const storage = createMemoryStorage();
		vi.stubGlobal("window", { localStorage: storage });
		const factory = new IDBFactory();
		const now = Date.now();
		startDiagnosticSession(DEFAULT_DIAGNOSTIC_DURATION_MS, storage, now);

		const sink = new DiagnosticLogSink({
			factory,
			maxBatchSize: 2,
			maxRecords: 2,
		});
		sink.write(record(now));
		sink.write(record(now + 1));
		sink.write(record(now + 2));
		await sink.flush();

		const opened = await openLogDatabase(factory);
		if (!opened.ok) throw new Error(opened.reason);
		expect(await countLogs(opened.db)).toBe(2);
		expect(
			(await queryLogsByRange(opened.db)).map((entry) => entry.event),
		).toEqual([`test.${now + 1}`, `test.${now + 2}`]);
		opened.db.close();
	});
});
