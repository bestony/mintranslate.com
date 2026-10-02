import { describe, expect, it } from "vitest";

import type { Connection, ModelTier } from "./model";
import { describeTierTarget, resolveTier } from "./tiers";

/** Build a connection with sensible defaults; override per test. */
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

describe("resolveTier — availability", () => {
	it("reports unavailable when nothing is configured", () => {
		const result = resolveTier("advanced", []);
		expect(result.kind).toBe("unavailable");
	});

	it("ignores connections that have not passed their test", () => {
		const untested = connection({ id: "a", status: "untested" });
		expect(resolveTier("advanced", [untested]).kind).toBe("unavailable");
	});

	it("ignores connections with an empty endpoint or model", () => {
		const incomplete = connection({ id: "a", endpoint: "   " });
		expect(resolveTier("advanced", [incomplete]).kind).toBe("unavailable");
	});
});

describe("resolveTier — explicit assignment wins", () => {
	it("uses the explicitly assigned connection", () => {
		const fast = connection({ id: "fast", tier: "fast", model: "small" });
		const advanced = connection({
			id: "adv",
			tier: "advanced",
			model: "large",
		});

		const result = resolveTier("fast", [advanced, fast]);
		expect(result.kind).toBe("resolved");
		if (result.kind !== "resolved") return;
		expect(result.connection.id).toBe("fast");
		expect(result.derived).toBe(false);
	});

	it("does not fall back to the other tier when the requested tier is unassigned", () => {
		// Everything usable is pinned to `advanced`, so `fast` has nothing and
		// must say so rather than silently serving the advanced connection.
		const advanced = connection({ id: "adv", tier: "advanced" });
		const result = resolveTier("fast", [advanced]);
		expect(result.kind).toBe("unavailable");
	});

	it("never resolves a tier to a connection pinned to the other tier", () => {
		const fastOnly = connection({ id: "fast", tier: "fast" });
		expect(resolveTier("advanced", [fastOnly]).kind).toBe("unavailable");
	});
});

describe("resolveTier — derivation when unassigned", () => {
	it("treats a vision-capable connection as the advanced default", () => {
		const text = connection({
			id: "text",
			capabilities: { text: true, vision: false },
		});
		const vision = connection({
			id: "vision",
			capabilities: { text: true, vision: true },
		});

		const result = resolveTier("advanced", [text, vision]);
		expect(result.kind).toBe("resolved");
		if (result.kind !== "resolved") return;
		expect(result.connection.id).toBe("vision");
		expect(result.derived).toBe(true);
	});

	it("treats the text-only connection as the fast default", () => {
		const text = connection({
			id: "text",
			capabilities: { text: true, vision: false },
		});
		const vision = connection({
			id: "vision",
			capabilities: { text: true, vision: true },
		});

		const result = resolveTier("fast", [text, vision]);
		expect(result.kind).toBe("resolved");
		if (result.kind !== "resolved") return;
		expect(result.connection.id).toBe("text");
	});

	it("breaks ties on recency so a newly edited connection wins", () => {
		const older = connection({ id: "older", updatedAt: 10 });
		const newer = connection({ id: "newer", updatedAt: 20 });
		const result = resolveTier("advanced", [older, newer]);
		if (result.kind !== "resolved") throw new Error("expected resolution");
		expect(result.connection.id).toBe("newer");
	});

	it("resolves both tiers to different connections when two are available", () => {
		const text = connection({
			id: "text",
			capabilities: { text: true, vision: false },
		});
		const vision = connection({
			id: "vision",
			capabilities: { text: true, vision: true },
		});
		const advanced = resolveTier("advanced", [text, vision]);
		const fast = resolveTier("fast", [text, vision]);
		if (advanced.kind !== "resolved" || fast.kind !== "resolved") {
			throw new Error("expected both tiers to resolve");
		}
		expect(advanced.connection.id).not.toBe(fast.connection.id);
	});

	it("resolves both tiers to the same single available connection", () => {
		const only = connection({ id: "only" });
		for (const tier of ["advanced", "fast"] as ModelTier[]) {
			const result = resolveTier(tier, [only]);
			if (result.kind !== "resolved") throw new Error("expected resolution");
			expect(result.connection.id).toBe("only");
		}
	});
});

describe("describeTierTarget", () => {
	it("names the connection and model so the tier is not a black box", () => {
		const chosen = connection({
			id: "a",
			name: "OpenAI · gpt-4o",
			model: "gpt-4o",
		});
		expect(describeTierTarget("advanced", [chosen])).toBe(
			"OpenAI · gpt-4o（gpt-4o）",
		);
	});

	it("explains the reason when the tier has no usable connection", () => {
		const description = describeTierTarget("fast", []);
		expect(description).toContain("尚未配置");
	});
});
