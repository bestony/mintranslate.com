/**
 * Prompt assembly contract.
 *
 * The load-bearing test here is the glossary comparison. The image path renders
 * its own glossary section because `assemblePrompt`'s renderer is private and that
 * file is under concurrent edit — but two renderers can drift, and a drifted
 * glossary means the same term is injected differently in text and image
 * translation, which users would experience as inconsistent terminology.
 *
 * So the formats are compared against each other rather than asserted to look
 * right. A failure here is the signal to export the shared function (design.md,
 * Resolved Decisions item 3).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import { assemblePrompt } from "#/lib/connections/styles";
import {
	assembleImagePrompt,
	IMAGE_PROMPT_LIMITS,
	orderGlossaryTerms,
	renderGlossarySection,
} from "./prompt";

/** Terms to exercise the shared ordering rules with. */
const TERMS = [
	{ source: "API", target: "接口" },
	{ source: "token", target: "令牌" },
] as const;

/**
 * Pull the glossary section out of `assemblePrompt`'s user content.
 *
 * The section is the leading block, so the boundary is a blank line. Extracted
 * rather than re-rendered, so the comparison is against what the text path
 * actually sends.
 */
function glossarySectionFromTextPrompt(): string {
	const assembled = assemblePrompt({
		styleId: "literal",
		text: "API token",
		glossaryMatches: [...TERMS],
	});
	const [first] = assembled.userContent.split("\n\n");
	return first;
}

describe("glossary section matches the text path", () => {
	it("renders the same bytes as assemblePrompt", () => {
		const ordered = orderGlossaryTerms([...TERMS]);
		expect(renderGlossarySection(ordered)).toBe(
			glossarySectionFromTextPrompt(),
		);
	});

	it("orders terms the same way", () => {
		// The comparison above would still pass if both renderers were handed the
		// same wrong order, so ordering is checked against the text path's own
		// output too.
		const assembled = assemblePrompt({
			styleId: "literal",
			text: "x",
			glossaryMatches: [
				{ source: "low", target: "低" },
				{ source: "high", target: "高", priority: 10 },
			],
		});

		const lines = assembled.userContent
			.split("\n")
			.filter((line) => line.startsWith("- "));
		expect(lines[0]).toContain("high");

		const ours = renderGlossarySection(
			orderGlossaryTerms([
				{ source: "low", target: "低" },
				{ source: "high", target: "高", priority: 10 },
			]),
		);
		expect(ours.split("\n").filter((l) => l.startsWith("- "))[0]).toContain(
			"high",
		);
	});

	it("produces no section when there is nothing to inject", () => {
		expect(renderGlossarySection([])).toBe("");
	});

	it("caps the injected terms the same way", () => {
		const many = Array.from(
			{ length: IMAGE_PROMPT_LIMITS.maxInjectedTerms + 20 },
			(_, i) => ({
				source: `t${i}`,
				target: `T${i}`,
			}),
		);

		const assembled = assemblePrompt({
			styleId: "literal",
			text: "x",
			glossaryMatches: many,
		});
		const textLines = assembled.userContent
			.split("\n")
			.filter((line) => line.startsWith("- "));

		const ourLines = renderGlossarySection(orderGlossaryTerms(many))
			.split("\n")
			.filter((line) => line.startsWith("- "));

		expect(ourLines).toHaveLength(textLines.length);
	});

	it("omits the glossary block entirely from the user content when empty", () => {
		const prompt = assembleImagePrompt({ targetLanguageLabel: "中文" });
		expect(prompt.userContent).not.toContain("Glossary instructions");
		expect(prompt.userContent.startsWith("\n")).toBe(false);
	});
});

describe("system instruction asks for structure, not prose", () => {
	it("requires a JSON array", () => {
		const prompt = assembleImagePrompt({ targetLanguageLabel: "中文" });
		expect(prompt.systemInstruction).toContain("JSON array");
	});

	it("does not ask for translation only", () => {
		// The exact phrase the text path uses. Its presence here would contradict
		// the parser's expectation, so this asserts its absence.
		const prompt = assembleImagePrompt({ targetLanguageLabel: "中文" });
		expect(prompt.systemInstruction).not.toContain(
			"Return only the translation",
		);
	});

	it("states the coordinate convention", () => {
		const prompt = assembleImagePrompt({ targetLanguageLabel: "中文" });
		expect(prompt.systemInstruction).toContain("fractions of the image");
		expect(prompt.systemInstruction).toContain("0,0");
	});

	it("names the uncertainty field so the model can use it", () => {
		const prompt = assembleImagePrompt({ targetLanguageLabel: "中文" });
		expect(prompt.systemInstruction).toContain("uncertain");
	});

	it("invites omission instead of guessed positions", () => {
		const prompt = assembleImagePrompt({ targetLanguageLabel: "中文" });
		expect(prompt.systemInstruction).toContain("omit");
	});
});

describe("user content arrangement", () => {
	it("puts the glossary before the task", () => {
		const prompt = assembleImagePrompt({
			targetLanguageLabel: "中文",
			glossaryMatches: [...TERMS],
		});
		expect(prompt.userContent.indexOf("Glossary instructions")).toBeLessThan(
			prompt.userContent.indexOf("Read all text"),
		);
	});

	it("puts the custom instruction before the task", () => {
		const prompt = assembleImagePrompt({
			targetLanguageLabel: "中文",
			customInstruction: "保留专有名词",
		});
		expect(prompt.userContent.indexOf("保留专有名词")).toBeLessThan(
			prompt.userContent.indexOf("Read all text"),
		);
	});

	it("names the target language in the task line", () => {
		const prompt = assembleImagePrompt({ targetLanguageLabel: "日本語" });
		expect(prompt.userContent).toContain("日本語");
	});

	it("mentions the source language when one is known", () => {
		const prompt = assembleImagePrompt({
			targetLanguageLabel: "中文",
			sourceLanguageLabel: "英语",
		});
		expect(prompt.userContent).toContain("英语");
	});

	it("ignores a blank custom instruction", () => {
		const prompt = assembleImagePrompt({
			targetLanguageLabel: "中文",
			customInstruction: "   ",
		});
		expect(prompt.userContent.startsWith("Read all text")).toBe(true);
	});

	it("carries the style when one is resolved", () => {
		const prompt = assembleImagePrompt({
			targetLanguageLabel: "中文",
			styleLabel: "直译",
			styleDescription: "尽量贴近原文结构",
		});
		expect(prompt.systemInstruction).toContain("直译");
		expect(prompt.systemInstruction).toContain("尽量贴近原文结构");
	});
});
