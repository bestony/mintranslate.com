/**
 * Diagnostic IndexedDB Log Sink.
 *
 * Implements LogSink by buffering records and batch-writing to IndexedDB.
 * Complies with the logger invariant: never blocks the caller, never throws.
 */

import type { LogRecord, LogSink } from "../index";
import {
	DEFAULT_MAX_LOG_RECORDS,
	openLogDatabase,
	pruneOldLogs,
	writeLogBatch,
} from "./db";
import { isDiagnosticLoggingActive } from "./session";

export interface DiagnosticSinkOptions {
	readonly maxBatchSize?: number;
	readonly flushIntervalMs?: number;
	readonly maxRecords?: number;
	readonly factory?: IDBFactory;
}

export class DiagnosticLogSink implements LogSink {
	private buffer: LogRecord[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushing = false;
	private dbPromise: Promise<IDBDatabase | null> | null = null;
	private readonly maxBatchSize: number;
	private readonly flushIntervalMs: number;
	private readonly maxRecords: number;
	private readonly factory?: IDBFactory;

	constructor(options: DiagnosticSinkOptions = {}) {
		this.maxBatchSize = options.maxBatchSize ?? 50;
		this.flushIntervalMs = options.flushIntervalMs ?? 100;
		this.maxRecords = options.maxRecords ?? DEFAULT_MAX_LOG_RECORDS;
		this.factory = options.factory;
	}

	private async getDb(): Promise<IDBDatabase | null> {
		if (!this.dbPromise) {
			this.dbPromise = openLogDatabase(this.factory)
				.then((res) => (res.ok ? res.db : null))
				.catch(() => null);
		}
		return this.dbPromise;
	}

	write(record: LogRecord): void {
		// Only record logs when a diagnostic session is active.
		if (!isDiagnosticLoggingActive()) {
			return;
		}

		this.buffer.push(record);

		if (this.buffer.length >= this.maxBatchSize) {
			this.scheduleFlush(0);
		} else if (!this.flushTimer) {
			this.scheduleFlush(this.flushIntervalMs);
		}
	}

	private scheduleFlush(delayMs: number): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
		}

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, delayMs);
	}

	async flush(): Promise<void> {
		if (this.flushing || this.buffer.length === 0) {
			return;
		}

		const batch = this.buffer;
		this.buffer = [];
		this.flushing = true;

		try {
			const db = await this.getDb();
			if (db) {
				await writeLogBatch(db, batch);
				await pruneOldLogs(db, this.maxRecords);
			}
		} catch {
			// Swallow any write failure to never disrupt caller
		} finally {
			this.flushing = false;
			// If more arrived while flushing, schedule next flush
			if (this.buffer.length > 0) {
				this.scheduleFlush(this.flushIntervalMs);
			}
		}
	}
}

/** Singleton instance used by the application logger. */
export const diagnosticSink = new DiagnosticLogSink();
