import { describe, expect, it } from "vitest";

import type { StoredLogRecord } from "./db";
import { buildAgentLogPayload } from "./export";

describe("agent log export payload", () => {
	it("constructs payload with environment, summary, and sorted events", () => {
		const now = Date.now();
		const logs: StoredLogRecord[] = [
			{
				id: 1,
				level: "info",
				event: "model.call.start",
				timestamp: now - 4000,
				isoTime: new Date(now - 4000).toISOString(),
				requestId: "req1",
				fields: { model: "gpt-4o" },
			},
			{
				id: 2,
				level: "error",
				event: "model.call.failed",
				timestamp: now - 2000,
				isoTime: new Date(now - 2000).toISOString(),
				requestId: "req1",
				fields: { error: "timeout" },
			},
			{
				id: 3,
				level: "warn",
				event: "connection.test.failed",
				timestamp: now - 1000,
				isoTime: new Date(now - 1000).toISOString(),
				fields: { reason: "429" },
			},
		];

		const payload = buildAgentLogPayload(logs, {
			since: now - 5000,
			until: now,
		});

		expect(payload.exportVersion).toBe(1);
		expect(payload.session.environment.app).toBe("MinTranslate");
		expect(payload.summary.totalLogs).toBe(3);
		expect(payload.summary.countsByLevel).toEqual({
			debug: 0,
			info: 1,
			warn: 1,
			error: 1,
		});
		expect(payload.summary.uniqueEvents).toEqual([
			"connection.test.failed",
			"model.call.failed",
			"model.call.start",
		]);
		expect(payload.summary.recentErrors).toHaveLength(2);
		expect(payload.logs).toHaveLength(3);
	});

	it("redacts credential-shaped fields before export", () => {
		const payload = buildAgentLogPayload(
			[
				{
					level: "error",
					event: "connection.test.failed",
					timestamp: 1000,
					isoTime: new Date(1000).toISOString(),
					fields: {
						apiKey: "secret-api-key",
						nested: { Authorization: "Bearer secret-token" },
					},
				},
			],
			{ since: 0, until: 2000 },
		);

		expect(payload.logs[0].fields).toEqual({
			apiKey: "[已脱敏]",
			nested: { Authorization: "[已脱敏]" },
		});
		expect(payload.summary.recentErrors[0].fields).toEqual(
			payload.logs[0].fields,
		);
	});

	it("exports recent logs via exportLogsForAgent directly from database", async () => {
		const { IDBFactory } = await import("fake-indexeddb");
		const { openLogDatabase, writeLogBatch } = await import("./db");
		const { exportLogsForAgent } = await import("./export");

		const factory = new IDBFactory();
		const opened = await openLogDatabase(factory);
		if (!opened.ok) throw new Error(opened.reason);

		const now = Date.now();
		await writeLogBatch(opened.db, [
			{
				level: "info",
				event: "pipeline.start",
				timestamp: now - 1000,
				fields: { item: "alpha" },
			},
		]);

		const payload = await exportLogsForAgent({
			since: now - 5000,
			until: now + 1000,
			database: opened.db,
		});

		expect(payload.summary.totalLogs).toBe(1);
		expect(payload.logs[0].event).toBe("pipeline.start");
	});
});
