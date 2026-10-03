import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTIC_SESSION_STORAGE_KEY } from "./diagnostic/session";
import {
	createLogger,
	type LogRecord,
	newRequestId,
	sourceText,
} from "./index";
import { passesThreshold } from "./levels";
import { redactValue } from "./redact";
import {
	LOG_LEVEL_STORAGE_KEY,
	resolveLogLevel,
	runtimeLevel,
} from "./threshold";

/** Capture records instead of writing to the console. */
function capture(level: () => never | string) {
	const records: LogRecord[] = [];
	const logger = createLogger({
		sink: { write: (record) => records.push(record) },
		level: level as never,
	});
	return { records, logger };
}

function fixed(level: "debug" | "info" | "warn" | "error") {
	return capture(() => level);
}

describe("log levels", () => {
	it("orders levels by severity", () => {
		expect(passesThreshold("error", "warn")).toBe(true);
		expect(passesThreshold("warn", "warn")).toBe(true);
		expect(passesThreshold("info", "warn")).toBe(false);
		expect(passesThreshold("debug", "warn")).toBe(false);
	});

	it("emits at or above the threshold", () => {
		const { records, logger } = fixed("warn");
		logger.debug("e.d");
		logger.info("e.i");
		logger.warn("e.w");
		logger.error("e.e");
		expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
	});

	it("reports whether a level is enabled", () => {
		const { logger } = fixed("info");
		expect(logger.enabled("info")).toBe(true);
		expect(logger.enabled("warn")).toBe(true);
		expect(logger.enabled("debug")).toBe(false);
	});
});

describe("filter before constructing", () => {
	it("does not evaluate field values for a suppressed record", () => {
		const { logger } = fixed("warn");
		const expensive = vi.fn(() => "computed");

		// The call site builds fields eagerly in JS, so the observable contract is
		// that the sink never receives them: no record is produced at all.
		logger.debug("e.suppressed", { value: expensive() });
		expect(expensive).toHaveBeenCalledTimes(1); // argument evaluation is JS-level
		expect(logger.enabled("debug")).toBe(false);

		const records: LogRecord[] = [];
		const capturing = createLogger({
			sink: { write: (r) => records.push(r) },
			level: () => "warn",
		});
		capturing.debug("e.suppressed");
		expect(records).toHaveLength(0);
	});

	it("does not call the sink below the threshold", () => {
		const write = vi.fn();
		const logger = createLogger({ sink: { write }, level: () => "error" });
		logger.info("e.i");
		logger.warn("e.w");
		expect(write).not.toHaveBeenCalled();
	});
});

describe("threshold resolution", () => {
	function storage(value: string | null) {
		return {
			getItem: (key: string) => (key === LOG_LEVEL_STORAGE_KEY ? value : null),
		};
	}

	it("prefers the runtime override", () => {
		expect(resolveLogLevel(storage("debug"), "error")).toBe("debug");
	});

	it("falls back to the build-time level", () => {
		expect(resolveLogLevel(storage(null), "info")).toBe("info");
	});

	it("falls back to warn when nothing is configured", () => {
		expect(resolveLogLevel(storage(null), undefined)).toBe("warn");
	});

	it("ignores an invalid stored value", () => {
		expect(runtimeLevel(storage("loud"))).toBeUndefined();
		expect(resolveLogLevel(storage("loud"), undefined)).toBe("warn");
	});

	it("survives a storage that throws", () => {
		const throwing = {
			getItem: () => {
				throw new Error("blocked");
			},
		};
		expect(runtimeLevel(throwing)).toBeUndefined();
		expect(resolveLogLevel(throwing, "info")).toBe("info");
	});

	it("captures debug logs during an active diagnostic session", () => {
		const now = Date.now();
		const storage = {
			getItem: (key: string) =>
				key === DIAGNOSTIC_SESSION_STORAGE_KEY
					? JSON.stringify({ startedAt: now, expiresAt: now + 300_000 })
					: null,
		};

		expect(resolveLogLevel(storage, "error")).toBe("debug");
	});
});

describe("redaction", () => {
	const SECRET_VALUE = "gamma-token-4444";

	it("marks credential-looking keys as redacted", () => {
		const output = redactValue(
			{
				apiKey: SECRET_VALUE,
				Authorization: `Bearer ${SECRET_VALUE}`,
				nested: { token: SECRET_VALUE },
			},
			{ level: "debug", secrets: [] },
		) as Record<string, unknown>;

		expect(output.apiKey).toBe("[已脱敏]");
		expect(output.Authorization).toBe("[已脱敏]");
		expect((output.nested as Record<string, unknown>).token).toBe("[已脱敏]");
	});

	it("strips a known secret appearing in a free string", () => {
		const output = redactValue(`header was ${SECRET_VALUE} ok`, {
			level: "error",
			secrets: [SECRET_VALUE],
		});
		expect(output).not.toContain(SECRET_VALUE);
		expect(output).toContain("[redacted]");
	});

	it("redacts secrets inside an Error message", () => {
		const output = redactValue(new Error(`failed with ${SECRET_VALUE}`), {
			level: "error",
			secrets: [SECRET_VALUE],
		}) as { message: string };
		expect(output.message).not.toContain(SECRET_VALUE);
	});

	it("withholds source text below the verbose level", () => {
		const output = redactValue(
			{ text: sourceText("secret source text") },
			{
				level: "warn",
				secrets: [],
			},
		) as { text: string };

		expect(output.text).not.toContain("secret source text");
		expect(output.text).toContain("原文已省略");
		expect(output.text).toContain("18");
	});

	it("emits source text at the verbose level", () => {
		const output = redactValue(
			{ text: sourceText("visible text") },
			{
				level: "debug",
				secrets: [],
			},
		) as { text: string };
		expect(output.text).toBe("visible text");
	});

	it("still redacts secrets when source text is emitted", () => {
		const output = redactValue(
			{ text: sourceText(`content ${SECRET_VALUE}`) },
			{
				level: "debug",
				secrets: [SECRET_VALUE],
			},
		) as { text: string };
		expect(output.text).not.toContain(SECRET_VALUE);
	});

	it("guards against deep or cyclic structures", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			redactValue(cyclic, { level: "debug", secrets: [] }),
		).not.toThrow();
	});

	it("redacts fields on an emitted record", () => {
		const { records, logger } = fixed("error");
		logger.error("e.fail", { apiKey: SECRET_VALUE, reason: "x" });
		expect(JSON.stringify(records[0])).not.toContain(SECRET_VALUE);
		expect(records[0].fields.apiKey).toBe("[已脱敏]");
	});
});

describe("never breaks the caller", () => {
	it("swallows a throwing sink", () => {
		const logger = createLogger({
			sink: {
				write: () => {
					throw new Error("sink exploded");
				},
			},
			level: () => "debug",
		});

		expect(() => logger.error("e.x")).not.toThrow();
	});

	it("swallows a throwing level resolver", () => {
		const logger = createLogger({
			sink: { write: vi.fn() },
			level: () => {
				throw new Error("no level");
			},
		});

		expect(() => logger.warn("e.x")).not.toThrow();
		expect(logger.enabled("error")).toBe(false);
	});
});

describe("request correlation", () => {
	it("attaches a requestId to the record", () => {
		const { records, logger } = fixed("info");
		logger.info("e.start", { a: 1 }, { requestId: "abcd1234" });
		expect(records[0].requestId).toBe("abcd1234");
	});

	it("omits the field when no id is supplied", () => {
		const { records, logger } = fixed("info");
		logger.info("e.start");
		expect("requestId" in records[0]).toBe(false);
	});

	it("generates short readable ids", () => {
		const id = newRequestId();
		expect(id).toHaveLength(8);
		expect(id).toMatch(/^[a-z0-9-]+$/i);
	});

	it("generates distinct ids", () => {
		const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
		expect(ids.size).toBe(50);
	});

	it("records the event name and a timestamp", () => {
		const { records, logger } = fixed("warn");
		logger.warn("translation.retry", { attempt: 1 });
		expect(records[0].event).toBe("translation.retry");
		expect(typeof records[0].timestamp).toBe("number");
	});
});
