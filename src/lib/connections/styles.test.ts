import { describe, expect, it } from "vitest";
import { assemblePrompt } from "./styles";

describe("assemblePrompt glossary integration", () => {
	const base = { styleId: "free" as const, text: "Translate this" };

	it("keeps old output when no glossary matches are provided", () => {
		const result = assemblePrompt(base);
		expect(result.userContent).toBe("Translate this");
		expect(result.glossaryMatches).toEqual([]);
		expect(result.injectedGlossaryMatches).toEqual([]);
	});

	it("adds a mandatory glossary block without changing system instructions", () => {
		const without = assemblePrompt(base);
		const result = assemblePrompt({
			...base,
			glossaryMatches: [
				{ source: "low", target: "低", priority: 1, index: 2 },
				{ source: "high", target: "高", priority: 9, index: 10 },
			],
		});
		expect(result.systemInstruction).toBe(without.systemInstruction);
		expect(result.userContent).toContain("Glossary instructions (mandatory):");
		expect(result.userContent.indexOf("high => 高")).toBeLessThan(
			result.userContent.indexOf("low => 低"),
		);
	});

	it("injects at most 50 entries and returns the full hit list", () => {
		const matches = Array.from({ length: 55 }, (_, index) => ({
			source: `s${index}`,
			target: `t${index}`,
			priority: 0,
			index,
		}));
		const result = assemblePrompt({ ...base, glossaryMatches: matches });
		expect(result.glossaryMatches).toHaveLength(55);
		expect(result.injectedGlossaryMatches).toHaveLength(50);
		expect(result.userContent).toContain("s49 => t49");
		expect(result.userContent).not.toContain("s50 => t50");
	});
});
