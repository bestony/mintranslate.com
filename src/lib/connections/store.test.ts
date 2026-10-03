import { describe, expect, it } from "vitest";

import type { Connection } from "./model";
import {
	builtinConnectionSupport,
	seedBuiltinConnections,
	stripBuiltinKeys,
} from "./store";

function connection(
	overrides: Partial<Connection> & Pick<Connection, "id">,
): Connection {
	const { id, ...rest } = overrides;
	return {
		id,
		name: id,
		provider: "openai",
		endpoint: "https://example.test/v1",
		model: "model",
		capabilities: { text: true, vision: false },
		status: "ok",
		createdAt: 1,
		updatedAt: 1,
		...rest,
	};
}

describe("built-in connection seeding", () => {
	it("derives independent support from the three API presence flags", () => {
		expect(
			builtinConnectionSupport({
				translator: true,
				languageDetector: true,
				languageModel: false,
			}),
		).toEqual({ translator: true, multimodal: false });
	});

	it("keeps the Translator channel available without the optional detector", () => {
		expect(
			builtinConnectionSupport({
				translator: true,
				languageDetector: false,
				languageModel: false,
			}),
		).toEqual({ translator: true, multimodal: false });
	});

	it("seeds each supported connection once and preserves external connections", () => {
		const first = seedBuiltinConnections(
			[connection({ id: "external" })],
			{
				translator: true,
				multimodal: true,
			},
			10,
		);
		const second = seedBuiltinConnections(
			first,
			{
				translator: true,
				multimodal: true,
			},
			20,
		);
		expect(second).toHaveLength(3);
		expect(second.filter(({ id }) => id === "builtin-translator")).toHaveLength(
			1,
		);
		expect(second.filter(({ id }) => id === "builtin-multimodal")).toHaveLength(
			1,
		);
		expect(second.find(({ id }) => id === "external")?.updatedAt).toBe(1);
	});

	it("removes only the unsupported built-in connection", () => {
		const seeded = seedBuiltinConnections([], {
			translator: true,
			multimodal: true,
		});
		const translatorOnly = seedBuiltinConnections(seeded, {
			translator: true,
			multimodal: false,
		});
		expect(translatorOnly.map(({ id }) => id)).toEqual(["builtin-translator"]);
	});

	it("derives download state without changing the fixed id or endpoint shape", () => {
		const seeded = seedBuiltinConnections(
			[],
			{ translator: true, multimodal: true },
			10,
			{ multimodal: { state: "downloadable" } },
		);
		const multimodal = seeded.find(({ id }) => id === "builtin-multimodal");
		expect(multimodal).toMatchObject({
			provider: "builtin-multimodal",
			endpoint: "",
			model: "",
			status: "ok",
		});
		expect(multimodal?.statusDetail).toBeUndefined();
	});

	it("strips fixed built-in ids from the key map", () => {
		expect(
			stripBuiltinKeys({
				builtinTranslator: "legacy",
				"builtin-translator": "secret",
				"builtin-multimodal": "secret",
				external: "kept",
			}),
		).toEqual({ builtinTranslator: "legacy", external: "kept" });
	});
});
