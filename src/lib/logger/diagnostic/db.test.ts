import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

if (typeof globalThis.IDBKeyRange === "undefined") {
	globalThis.IDBKeyRange = IDBKeyRange;
}

import type { LogRecord } from "../index";
import {
	clearLogs,
	countLogs,
	openLogDatabase,
	pruneOldLogs,
	queryLogsByRange,
	writeLogBatch,
	writeLogRecord,
} from "./db";

describe("diagnostic log database", () => {
	let db: IDBDatabase;

	beforeEach(async () => {
		const opened = await openLogDatabase(new IDBFactory());
		if (!opened.ok) throw new Error(opened.reason);
		db = opened.db;
	});

	it("opens database and creates schema", async () => {
		expect(db.objectStoreNames.contains("records")).toBe(true);
		const tx = db.transaction("records", "readonly");
		const store = tx.objectStore("records");
		expect(store.indexNames.contains("by_timestamp")).toBe(true);
		expect(store.indexNames.contains("by_level")).toBe(true);
	});

	it("writes and counts a single log record", async () => {
		const record: LogRecord = {
			level: "info",
			event: "test.event",
			timestamp: 1000,
			requestId: "req1",
			fields: { foo: "bar" },
		};

		await writeLogRecord(db, record);
		const count = await countLogs(db);
		expect(count).toBe(1);
	});

	it("writes records in batch and queries by timestamp range", async () => {
		const records: LogRecord[] = [
			{ level: "debug", event: "ev.1", timestamp: 100, fields: {} },
			{ level: "info", event: "ev.2", timestamp: 200, fields: {} },
			{ level: "warn", event: "ev.3", timestamp: 300, fields: {} },
			{ level: "error", event: "ev.4", timestamp: 400, fields: {} },
			{ level: "info", event: "ev.5", timestamp: 500, fields: {} },
		];

		await writeLogBatch(db, records);
		expect(await countLogs(db)).toBe(5);

		// Range query between 200 and 400
		const range = await queryLogsByRange(db, { since: 200, until: 400 });
		expect(range.map((r) => r.event)).toEqual(["ev.2", "ev.3", "ev.4"]);

		// Lower bound query
		const lower = await queryLogsByRange(db, { since: 300 });
		expect(lower.map((r) => r.event)).toEqual(["ev.3", "ev.4", "ev.5"]);

		// Limit and reverse direction
		const reversed = await queryLogsByRange(db, {
			limit: 2,
			direction: "prev",
		});
		expect(reversed.map((r) => r.event)).toEqual(["ev.5", "ev.4"]);
	});

	it("clears all records", async () => {
		await writeLogBatch(db, [
			{ level: "info", event: "ev.1", timestamp: 100, fields: {} },
			{ level: "info", event: "ev.2", timestamp: 200, fields: {} },
		]);
		expect(await countLogs(db)).toBe(2);

		await clearLogs(db);
		expect(await countLogs(db)).toBe(0);
	});

	it("prunes oldest records beyond keepLimit", async () => {
		const records: LogRecord[] = [
			{ level: "info", event: "ev.1", timestamp: 100, fields: {} },
			{ level: "info", event: "ev.2", timestamp: 200, fields: {} },
			{ level: "info", event: "ev.3", timestamp: 300, fields: {} },
			{ level: "info", event: "ev.4", timestamp: 400, fields: {} },
		];
		await writeLogBatch(db, records);

		const deleted = await pruneOldLogs(db, 2);
		expect(deleted).toBe(2);
		expect(await countLogs(db)).toBe(2);

		const remaining = await queryLogsByRange(db);
		expect(remaining.map((r) => r.event)).toEqual(["ev.3", "ev.4"]);
	});
});
