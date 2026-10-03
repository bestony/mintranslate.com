import { describe, expect, it } from "vitest";

import {
	activationBlocker,
	applyEdit,
	type Connection,
	canActivate,
	defaultConnectionName,
} from "./model";
import {
	CONNECTIONS_KEY,
	deserializeConnections,
	deserializeKeys,
	exportConfiguration,
	KEYS_KEY,
	type KeyValueStore,
	loadKeys,
	serializeConnections,
	serializeKeys,
} from "./storage";

/** In-memory store that satisfies the persistence surface. */
function memoryStore(seed: Record<string, string> = {}): KeyValueStore & {
	readonly data: Record<string, string>;
} {
	const data = { ...seed };
	return {
		data,
		getItem: (key) => data[key] ?? null,
		setItem: (key, value) => {
			data[key] = value;
		},
		removeItem: (key) => {
			delete data[key];
		},
	};
}

function connection(
	overrides: Partial<Connection> & Pick<Connection, "id">,
): Connection {
	return {
		name: overrides.id,
		provider: "openai",
		endpoint: "https://api.example.com/v1",
		model: "some-model",
		capabilities: { text: true, vision: false },
		status: "ok",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("activation gating", () => {
	it("allows activation only when tested, complete and keyed", () => {
		const ready = connection({ id: "a", status: "ok" });
		expect(canActivate(ready, true)).toBe(true);
	});

	it("rejects an untested connection and says why", () => {
		const untested = connection({ id: "a", status: "untested" });
		expect(canActivate(untested, true)).toBe(false);
		expect(activationBlocker(untested, true)).toContain("连接测试");
	});

	it("rejects a failed connection and says why", () => {
		const failed = connection({ id: "a", status: "failed" });
		expect(canActivate(failed, true)).toBe(false);
		expect(activationBlocker(failed, true)).toContain("连接测试");
	});

	it("rejects a missing key", () => {
		const ready = connection({ id: "a", status: "ok" });
		expect(activationBlocker(ready, false)).toContain("API Key");
	});

	it("rejects an empty endpoint or model", () => {
		expect(
			activationBlocker(connection({ id: "a", endpoint: " " }), true),
		).toContain("Endpoint");
		expect(
			activationBlocker(connection({ id: "a", model: "" }), true),
		).toContain("Model");
	});

	it("reports an in-progress test distinctly", () => {
		const testing = connection({ id: "a", status: "testing" });
		expect(activationBlocker(testing, true)).toContain("进行中");
	});
});

describe("applyEdit — test invalidation", () => {
	it("returns a tested connection to untested when the endpoint changes", () => {
		const before = connection({ id: "a", status: "ok" });
		const after = applyEdit(
			before,
			{ endpoint: "https://other.example.com/v1" },
			99,
		);
		expect(after.status).toBe("untested");
		expect(after.updatedAt).toBe(99);
	});

	it("returns a tested connection to untested when the model changes", () => {
		const before = connection({ id: "a", status: "ok" });
		expect(applyEdit(before, { model: "other" }, 99).status).toBe("untested");
	});

	it("clears a stale failure detail when invalidating", () => {
		const before = connection({
			id: "a",
			status: "failed",
			statusDetail: "401",
		});
		expect(
			applyEdit(before, { model: "other" }, 99).statusDetail,
		).toBeUndefined();
	});

	it("keeps the tested state when only the name or capabilities change", () => {
		const before = connection({ id: "a", status: "ok" });
		const after = applyEdit(
			before,
			{ name: "renamed", capabilities: { text: true, vision: true } },
			99,
		);
		expect(after.status).toBe("ok");
	});

	it("keeps the tested state when the same endpoint is rewritten", () => {
		const before = connection({ id: "a", status: "ok" });
		expect(applyEdit(before, { endpoint: before.endpoint }, 99).status).toBe(
			"ok",
		);
	});
});

describe("defaultConnectionName", () => {
	it("joins provider label and model", () => {
		expect(defaultConnectionName("OpenAI", "gpt-4o")).toBe("OpenAI · gpt-4o");
	});

	it("falls back to the provider label while the model is empty", () => {
		expect(defaultConnectionName("OpenAI", "   ")).toBe("OpenAI");
	});
});

describe("connection serialization", () => {
	it("round-trips both built-in connections with empty endpoint and model", () => {
		const builtins = [
			connection({
				id: "builtin-translator",
				provider: "builtin-translator",
				name: "内置翻译（仅文本）",
				endpoint: "",
				model: "",
				capabilities: { text: true, vision: false },
			}),
			connection({
				id: "builtin-multimodal",
				provider: "builtin-multimodal",
				name: "内置多模态（文本与图片）",
				endpoint: "",
				model: "",
				capabilities: { text: true, vision: true },
			}),
		];
		expect(
			deserializeConnections(serializeConnections(builtins)).value,
		).toEqual(builtins);
	});
	it("round-trips a connection", () => {
		const original = connection({ id: "a", tier: "advanced" });
		const restored = deserializeConnections(serializeConnections([original]));
		expect(restored.value).toEqual([original]);
	});

	it("never writes a key-like field even if one is present on the object", () => {
		const tainted = {
			...connection({ id: "a" }),
			apiKey: "alpha-token-1111",
		} as Connection;
		expect(serializeConnections([tainted])).not.toContain("alpha-token-1111");
	});

	it("discards unparsable storage instead of throwing", () => {
		const result = deserializeConnections("{not json");
		expect(result.value).toEqual([]);
		expect(result.discarded).toBeDefined();
	});

	it("skips malformed entries but keeps valid ones", () => {
		// Two malformed entries: an unknown provider id and a non-object.
		const raw = JSON.stringify([
			JSON.parse(serializeConnections([connection({ id: "good" })]))[0],
			{ id: "bad", provider: "nonexistent" },
			{ nope: true },
		]);
		const result = deserializeConnections(raw);
		expect(result.value.map((entry) => entry.id)).toEqual(["good"]);
		expect(result.discarded).toContain("2");
	});

	it("treats an unknown status as malformed", () => {
		const raw = JSON.stringify([{ ...connection({ id: "a" }), status: "wat" }]);
		expect(deserializeConnections(raw).value).toEqual([]);
	});

	it("treats empty storage as no connections", () => {
		expect(deserializeConnections(null).value).toEqual([]);
	});
});

describe("key storage", () => {
	it("never serializes fixed built-in connection ids", () => {
		const serialized = serializeKeys({
			"builtin-translator": "must-not-persist",
			"builtin-multimodal": "must-not-persist",
			external: "kept",
		});
		expect(serialized).not.toContain("must-not-persist");
		expect(deserializeKeys(serialized)).toEqual({ external: "kept" });
	});
	it("round-trips the key map", () => {
		const keys = { a: "alpha-token-1111" };
		expect(deserializeKeys(serializeKeys(keys))).toEqual(keys);
	});

	it("drops non-string entries", () => {
		expect(deserializeKeys('{"a":"x","b":1,"c":null}')).toEqual({ a: "x" });
	});

	it("returns an empty map for corrupt storage", () => {
		expect(deserializeKeys("nope")).toEqual({});
	});

	it("stores keys in a different slot from connections", () => {
		expect(KEYS_KEY).not.toBe(CONNECTIONS_KEY);
	});

	it("reads keys from the key slot only", () => {
		const store = memoryStore({
			[CONNECTIONS_KEY]: "[]",
			[KEYS_KEY]: '{"a":"secret"}',
		});
		expect(loadKeys(store)).toEqual({ a: "secret" });
	});
});

describe("exportConfiguration", () => {
	it("excludes keys by default", () => {
		const exported = exportConfiguration([connection({ id: "a" })], false, {
			a: "alpha-token-1111",
		});
		expect(exported).not.toContain("alpha-token-1111");
		expect(exported).not.toContain("credentials");
		expect(exported).toContain("connections");
	});

	it("includes keys only when explicitly requested", () => {
		const exported = exportConfiguration([connection({ id: "a" })], true, {
			a: "alpha-token-1111",
		});
		expect(exported).toContain("alpha-token-1111");
	});

	it("carries a version marker for future migrations", () => {
		expect(exportConfiguration([], false)).toContain('"version": 1');
	});
});
