import { describe, expect, it } from "vitest";

import {
	ANALYTICS_ENABLED_KEY,
	type AnalyticsStorage,
	isValidMeasurementId,
	MEASUREMENT_ID_KEY,
	resolveConfig,
	saveId,
	saveStatisticsEnabled,
	statisticsEnabled,
	storedId,
} from "./config";

/** In-memory storage with a controllable failure mode. */
function storage(
	seed: Record<string, string> = {},
	options: { throw?: boolean } = {},
) {
	const data = { ...seed };
	return {
		data,
		getItem: (key: string) => {
			if (options.throw) throw new Error("blocked");
			return data[key] ?? null;
		},
		setItem: (key: string, value: string) => {
			if (options.throw) throw new Error("blocked");
			data[key] = value;
		},
		removeItem: (key: string) => {
			if (options.throw) throw new Error("blocked");
			delete data[key];
		},
	} satisfies AnalyticsStorage & { data: Record<string, string> };
}

describe("identifier validation", () => {
	it("accepts the documented GA4 format", () => {
		expect(isValidMeasurementId("G-TEST123")).toBe(true);
		expect(isValidMeasurementId("G-ABCDEF1234")).toBe(true);
	});

	it("rejects a missing prefix", () => {
		expect(isValidMeasurementId("TEST123")).toBe(false);
	});

	it("rejects surrounding whitespace", () => {
		// A stray space is a paste artifact, not something to silently trim.
		expect(isValidMeasurementId(" G-TEST123 ")).toBe(false);
	});

	it("rejects a too-short identifier", () => {
		expect(isValidMeasurementId("G-ABC")).toBe(false);
	});

	it("rejects non-strings and empty values", () => {
		expect(isValidMeasurementId(undefined)).toBe(false);
		expect(isValidMeasurementId("")).toBe(false);
		expect(isValidMeasurementId(42)).toBe(false);
	});
});

describe("runtime identifier storage", () => {
	it("round-trips a valid identifier", () => {
		const store = storage();
		saveId("G-RUNTIME1", store);
		expect(storedId(store)).toBe("G-RUNTIME1");
	});

	it("falls back to undefined for an invalid stored value", () => {
		expect(
			storedId(storage({ [MEASUREMENT_ID_KEY]: "nonsense" })),
		).toBeUndefined();
	});

	it("clears the slot when an invalid value is saved", () => {
		const store = storage({ [MEASUREMENT_ID_KEY]: "G-OLD1234" });
		saveId("bad", store);
		expect(store.data[MEASUREMENT_ID_KEY]).toBeUndefined();
	});

	it("does not throw when storage throws", () => {
		const broken = storage({}, { throw: true });
		expect(() => saveId("G-TEST123", broken)).not.toThrow();
		expect(storedId(broken)).toBeUndefined();
	});

	it("uses a versioned slot name", () => {
		expect(MEASUREMENT_ID_KEY).toBe("mintranslate.analytics-id.v1");
	});

	it("defaults to undefined without storage", () => {
		expect(storedId(undefined)).toBeUndefined();
	});
});

describe("configuration resolution", () => {
	it("reports no identifier when nothing is configured", () => {
		const config = resolveConfig(storage());
		expect(config.measurementId).toBeUndefined();
		expect(config.source).toBe("none");
	});

	it("prefers the build-time identifier over a stored one", () => {
		// A deployment pins analytics; a user must not be able to redirect it.
		const store = storage({ [MEASUREMENT_ID_KEY]: "G-RUNTIME1" });
		const config = resolveConfig(store, { measurementId: "G-BUILD1234" });
		expect(config.measurementId).toBe("G-BUILD1234");
		expect(config.source).toBe("build");
		expect(config.fromDeployment).toBe(true);
	});

	it("falls back to the runtime identifier", () => {
		const store = storage({ [MEASUREMENT_ID_KEY]: "G-RUNTIME1" });
		const config = resolveConfig(store, {});
		expect(config.measurementId).toBe("G-RUNTIME1");
		expect(config.source).toBe("runtime");
		expect(config.fromDeployment).toBe(false);
	});

	it("ignores an invalid build-time identifier", () => {
		const config = resolveConfig(storage(), { measurementId: "not-an-id" });
		expect(config.measurementId).toBeUndefined();
		expect(config.source).toBe("none");
	});

	it("marks the identifier as deployment-provided for the read-only field", () => {
		expect(
			resolveConfig(storage(), { measurementId: "G-BUILD1234" }).fromDeployment,
		).toBe(true);
	});
});

describe("statistics toggle", () => {
	it("defaults to on", () => {
		expect(statisticsEnabled(storage())).toBe(true);
	});

	it("persists the off state", () => {
		const store = storage();
		saveStatisticsEnabled(false, store);
		expect(statisticsEnabled(store)).toBe(false);
	});

	it("persists the on state", () => {
		const store = storage({ [ANALYTICS_ENABLED_KEY]: "false" });
		saveStatisticsEnabled(true, store);
		expect(statisticsEnabled(store)).toBe(true);
	});

	it("treats an unknown stored value as on", () => {
		expect(
			statisticsEnabled(storage({ [ANALYTICS_ENABLED_KEY]: "maybe" })),
		).toBe(true);
	});

	it("defaults to on when storage throws", () => {
		expect(statisticsEnabled(storage({}, { throw: true }))).toBe(true);
	});

	it("does not throw when persisting fails", () => {
		expect(() =>
			saveStatisticsEnabled(false, storage({}, { throw: true })),
		).not.toThrow();
	});

	it("uses a versioned slot name", () => {
		expect(ANALYTICS_ENABLED_KEY).toBe("mintranslate.analytics-enabled.v1");
	});

	it("defaults to on without storage", () => {
		expect(statisticsEnabled(undefined)).toBe(true);
	});
});
