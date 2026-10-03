/**
 * Agent-friendly log export builder and downloader.
 *
 * Formats diagnostic records with rich session metadata, summary statistics,
 * and sanitized event streams so that an LLM agent or human developer can
 * inspect, reproduce, and diagnose issues without manual parsing.
 */

import { ANALYTICS_ENABLED_KEY } from "#/lib/analytics/config";
import { CONNECTIONS_KEY, KEYS_KEY, TIER_KEY } from "#/lib/connections/storage";
import { TRANSLATION_MEMORY_ENABLED_KEY } from "#/lib/translation-memory/preference";
import { redactValue } from "../redact";
import type { StoredLogRecord } from "./db";
import { openLogDatabase, queryLogsByRange } from "./db";
import { diagnosticSink } from "./sink";

export const EXPORT_SCHEMA =
	"https://mintranslate.app/schemas/agent-log-export-v1.json";
export const AGENT_EXPORT_VERSION = 1;

export interface AgentLogExportPayload {
	readonly $schema: string;
	readonly exportVersion: number;
	readonly generatedAt: string;
	readonly session: {
		readonly timeWindow: {
			readonly since: number;
			readonly until: number;
			readonly durationSeconds: number;
			readonly sinceIso: string;
			readonly untilIso: string;
		};
		readonly environment: {
			readonly app: string;
			readonly userAgent: string;
			readonly platform: string;
			readonly language: string;
			readonly online: boolean;
			readonly isSecureContext: boolean;
			readonly isStandalone: boolean;
		};
		readonly config: {
			readonly activeTier?: string;
			readonly connectionsSummary: readonly {
				readonly id: string;
				readonly name: string;
				readonly provider: string;
				readonly model: string;
				readonly status: string;
				readonly hasKey: boolean;
			}[];
			readonly translationMemoryEnabled: boolean;
			readonly analyticsEnabled: boolean;
		};
	};
	readonly summary: {
		readonly totalLogs: number;
		readonly countsByLevel: {
			readonly debug: number;
			readonly info: number;
			readonly warn: number;
			readonly error: number;
		};
		readonly uniqueEvents: readonly string[];
		readonly recentErrors: readonly {
			readonly timestamp: number;
			readonly isoTime: string;
			readonly event: string;
			readonly requestId?: string;
			readonly fields: Record<string, unknown>;
		}[];
	};
	readonly logs: readonly StoredLogRecord[];
}

function collectEnvironment(): AgentLogExportPayload["session"]["environment"] {
	const nav = typeof navigator !== "undefined" ? navigator : undefined;
	const win = typeof window !== "undefined" ? window : undefined;

	return {
		app: "MinTranslate",
		userAgent: nav?.userAgent ?? "unknown",
		platform: nav?.platform ?? "unknown",
		language: nav?.language ?? "unknown",
		online: nav?.onLine ?? true,
		isSecureContext: globalThis.isSecureContext === true,
		isStandalone:
			win?.matchMedia?.("(display-mode: standalone)")?.matches ?? false,
	};
}

function collectConfig(): AgentLogExportPayload["session"]["config"] {
	let connectionsSummary: Array<{
		id: string;
		name: string;
		provider: string;
		model: string;
		status: string;
		hasKey: boolean;
	}> = [];

	try {
		if (typeof window === "undefined") {
			return {
				connectionsSummary,
				translationMemoryEnabled: true,
				analyticsEnabled: true,
			};
		}

		const storage = window.localStorage;
		const rawConns = storage.getItem(CONNECTIONS_KEY);
		const rawKeys = storage.getItem(KEYS_KEY);
		const parsedKeys: unknown = rawKeys ? JSON.parse(rawKeys) : {};
		const keysMap: Record<string, string> =
			parsedKeys !== null &&
			typeof parsedKeys === "object" &&
			!Array.isArray(parsedKeys)
				? (parsedKeys as Record<string, string>)
				: {};

		if (rawConns) {
			const parsed: unknown = JSON.parse(rawConns);
			if (Array.isArray(parsed)) {
				connectionsSummary = parsed.flatMap((entry) => {
					if (entry === null || typeof entry !== "object") return [];
					const c = entry as Record<string, unknown>;
					const id = typeof c.id === "string" ? c.id : "";
					if (id === "") return [];
					return [
						{
							id,
							name:
								typeof c.name === "string" && c.name !== "" ? c.name : "未命名",
							provider: typeof c.provider === "string" ? c.provider : "custom",
							model: typeof c.model === "string" ? c.model : "",
							status: typeof c.status === "string" ? c.status : "untested",
							hasKey:
								typeof keysMap[id] === "string" && keysMap[id].trim() !== "",
						},
					];
				});
			}
		}

		const storedTier = storage.getItem(TIER_KEY);
		const activeTier =
			storedTier === "advanced" || storedTier === "fast"
				? storedTier
				: undefined;
		const translationMemoryEnabled =
			storage.getItem(TRANSLATION_MEMORY_ENABLED_KEY) !== "false";
		const analyticsEnabled = storage.getItem(ANALYTICS_ENABLED_KEY) !== "false";

		return {
			...(activeTier !== undefined && { activeTier }),
			connectionsSummary,
			translationMemoryEnabled,
			analyticsEnabled,
		};
	} catch {
		// Storage can be blocked or contain malformed values. Keep the export useful.
		return {
			connectionsSummary,
			translationMemoryEnabled: true,
			analyticsEnabled: true,
		};
	}
}

/** Apply the shared logger redactor before records leave local storage. */
function sanitizeStoredLog(log: StoredLogRecord): StoredLogRecord {
	const fields = redactValue(log.fields, { level: "debug", secrets: [] });
	return {
		...log,
		fields:
			fields !== null && typeof fields === "object" && !Array.isArray(fields)
				? (fields as Record<string, unknown>)
				: {},
	};
}

/** Build complete AgentLogExportPayload from records and time window. */
export function buildAgentLogPayload(
	logs: readonly StoredLogRecord[],
	timeWindow: { readonly since: number; readonly until: number },
): AgentLogExportPayload {
	const safeLogs = logs.map(sanitizeStoredLog);
	const countsByLevel = { debug: 0, info: 0, warn: 0, error: 0 };
	const eventsSet = new Set<string>();
	const recentErrors: Array<{
		timestamp: number;
		isoTime: string;
		event: string;
		requestId?: string;
		fields: Record<string, unknown>;
	}> = [];

	for (const log of safeLogs) {
		if (log.level in countsByLevel) {
			countsByLevel[log.level] += 1;
		}
		eventsSet.add(log.event);

		if (log.level === "error" || log.level === "warn") {
			recentErrors.push({
				timestamp: log.timestamp,
				isoTime: log.isoTime,
				event: log.event,
				...(log.requestId !== undefined && { requestId: log.requestId }),
				fields: log.fields,
			});
		}
	}

	return {
		$schema: EXPORT_SCHEMA,
		exportVersion: AGENT_EXPORT_VERSION,
		generatedAt: new Date().toISOString(),
		session: {
			timeWindow: {
				since: timeWindow.since,
				until: timeWindow.until,
				durationSeconds: Math.round(
					(timeWindow.until - timeWindow.since) / 1000,
				),
				sinceIso: new Date(timeWindow.since).toISOString(),
				untilIso: new Date(timeWindow.until).toISOString(),
			},
			environment: collectEnvironment(),
			config: collectConfig(),
		},
		summary: {
			totalLogs: safeLogs.length,
			countsByLevel,
			uniqueEvents: Array.from(eventsSet).sort(),
			recentErrors,
		},
		logs: safeLogs,
	};
}

/**
 * Fetch logs for the specified time window (defaulting to last 5 minutes)
 * and generate the structured Agent export payload.
 */
export async function exportLogsForAgent(
	options: {
		readonly since?: number;
		readonly until?: number;
		readonly database?: IDBDatabase;
	} = {},
): Promise<AgentLogExportPayload> {
	// Ensure buffered in-memory logs are written first
	await diagnosticSink.flush();

	const until = options.until ?? Date.now();
	// Default to last 5 minutes
	const since = options.since ?? until - 5 * 60 * 1000;

	let db = options.database;
	let closeDb = false;

	if (!db) {
		const openRes = await openLogDatabase();
		if (!openRes.ok) {
			throw new Error(openRes.reason);
		}
		db = openRes.db;
		closeDb = true;
	}

	try {
		const logs = await queryLogsByRange(db, {
			since,
			until,
			direction: "next",
		});
		return buildAgentLogPayload(logs, { since, until });
	} finally {
		if (closeDb && db) {
			db.close();
		}
	}
}

/**
 * Trigger download of the Agent-friendly JSON log export in browser.
 */
export function downloadAgentLogsPayload(
	payload: AgentLogExportPayload,
	suggestedFilename?: string,
): string {
	const filename =
		suggestedFilename ??
		`mintranslate-agent-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

	const json = JSON.stringify(payload, null, 2);
	const blob = new Blob([json], { type: "application/json;charset=utf-8" });
	const url = URL.createObjectURL(blob);

	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.style.display = "none";
	document.body?.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);

	return filename;
}
