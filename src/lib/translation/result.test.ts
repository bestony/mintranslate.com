import { describe, expect, it, vi } from "vitest";

import {
	acceptInput,
	COPY_FEEDBACK_MS,
	copyPlainText,
	countCharacters,
	counterLabel,
	counterState,
	MAX_INPUT_CHARACTERS,
	segmentTranslation,
	stripMarkdown,
	toPlainText,
	truncationNotice,
	WARNING_THRESHOLD,
} from "./result";

describe("segmentation", () => {
	it("splits on blank lines", () => {
		const segments = segmentTranslation("第一段。\n\n第二段。");
		expect(segments.map((s) => s.text)).toEqual(["第一段。", "第二段。"]);
	});

	it("returns nothing for empty input", () => {
		expect(segmentTranslation("")).toEqual([]);
		expect(segmentTranslation("   \n\n  ")).toEqual([]);
	});

	it("keeps a single paragraph as one segment", () => {
		expect(segmentTranslation("Just one sentence.").map((s) => s.text)).toEqual(
			["Just one sentence."],
		);
	});

	it("splits multiple sentences in one line", () => {
		const segments = segmentTranslation("One. Two. Three.");
		expect(segments.map((s) => s.text)).toEqual(["One.", "Two.", "Three."]);
	});

	it("handles CJK sentence punctuation", () => {
		const segments = segmentTranslation("你好。世界。");
		expect(segments.map((s) => s.text)).toEqual(["你好。", "世界。"]);
	});

	it("handles exclamation and question marks", () => {
		expect(segmentTranslation("Really? Yes!").map((s) => s.text)).toEqual([
			"Really?",
			"Yes!",
		]);
	});

	it("keeps trailing text without terminal punctuation", () => {
		expect(segmentTranslation("One. And then some").map((s) => s.text)).toEqual(
			["One.", "And then some"],
		);
	});

	it("assigns stable ascending indices", () => {
		const segments = segmentTranslation("A。\n\nB。\n\nC。");
		expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
	});

	it("collapses runs of blank lines without producing empty segments", () => {
		const segments = segmentTranslation("A。\n\n\n\nB。");
		expect(segments.map((s) => s.text)).toEqual(["A。", "B。"]);
	});

	it("preserves segment order", () => {
		const segments = segmentTranslation("First.\n\nSecond.\n\nThird.");
		expect(segments.map((s) => s.text)).toEqual([
			"First.",
			"Second.",
			"Third.",
		]);
	});
});

describe("markdown stripping", () => {
	it("removes bold and italic markers", () => {
		expect(stripMarkdown("**bold** and *italic*")).toBe("bold and italic");
	});

	it("removes inline code backticks", () => {
		expect(stripMarkdown("use `npm test`")).toBe("use npm test");
	});

	it("removes fenced code fences but keeps the code", () => {
		expect(stripMarkdown("```js\nconst a = 1\n```")).toBe("const a = 1");
	});

	it("removes heading markers", () => {
		expect(stripMarkdown("## Heading")).toBe("Heading");
	});

	it("removes list markers", () => {
		expect(stripMarkdown("- one\n- two")).toBe("one\ntwo");
		expect(stripMarkdown("1. one\n2. two")).toBe("one\ntwo");
	});

	it("removes block quote markers", () => {
		expect(stripMarkdown("> quoted")).toBe("quoted");
	});

	it("leaves plain prose untouched", () => {
		expect(stripMarkdown("Just a normal sentence.")).toBe(
			"Just a normal sentence.",
		);
	});

	it("does not mangle underscores inside identifiers", () => {
		expect(stripMarkdown("call my_function_name()")).toBe(
			"call my_function_name()",
		);
	});
});

describe("plain text output", () => {
	it("joins segments with exactly one blank line", () => {
		const segments = segmentTranslation("One.\n\nTwo.");
		expect(toPlainText(segments)).toBe("One.\n\nTwo.");
	});

	it("produces no Markdown markers", () => {
		const segments = segmentTranslation("**bold** text");
		expect(toPlainText(segments)).toBe("bold text");
	});

	it("introduces no leading or trailing whitespace", () => {
		const output = toPlainText(segmentTranslation("  One.  \n\n  Two.  "));
		expect(output).toBe(output.trim());
	});

	it("returns an empty string for no segments", () => {
		expect(toPlainText([])).toBe("");
	});

	it("preserves segment order", () => {
		expect(toPlainText(segmentTranslation("A。\n\nB。\n\nC。"))).toBe(
			"A。\n\nB。\n\nC。",
		);
	});
});

describe("character counting", () => {
	it("counts plain text", () => {
		expect(countCharacters("hello")).toBe(5);
	});

	it("counts an emoji as one character, not two", () => {
		// A surrogate pair is one code point but two UTF-16 units.
		expect("😀".length).toBe(2);
		expect(countCharacters("😀")).toBe(1);
	});

	it("counts mixed content by code point", () => {
		expect(countCharacters("a😀b")).toBe(3);
	});

	it("counts an empty string as zero", () => {
		expect(countCharacters("")).toBe(0);
	});
});

describe("counter state", () => {
	it("is normal below the warning threshold", () => {
		expect(counterState(0)).toBe("normal");
		expect(counterState(1000)).toBe("normal");
	});

	it("warns at exactly 90%", () => {
		const at90 = Math.floor(MAX_INPUT_CHARACTERS * WARNING_THRESHOLD);
		expect(counterState(at90)).toBe("warning");
	});

	it("reports at-limit at the maximum", () => {
		expect(counterState(MAX_INPUT_CHARACTERS)).toBe("at-limit");
		expect(counterState(MAX_INPUT_CHARACTERS + 1)).toBe("at-limit");
	});

	it("uses the decided 5000 character limit", () => {
		expect(MAX_INPUT_CHARACTERS).toBe(5000);
	});

	it("formats the label with the limit", () => {
		expect(counterLabel(19)).toContain("19");
		expect(counterLabel(19)).toContain("5,000");
	});
});

describe("input acceptance and truncation", () => {
	it("accepts input at the limit unchanged", () => {
		const text = "a".repeat(MAX_INPUT_CHARACTERS);
		const accepted = acceptInput(text);
		expect(accepted.text).toBe(text);
		expect(accepted.truncatedFrom).toBeUndefined();
	});

	it("truncates input over the limit and reports it", () => {
		const text = "a".repeat(MAX_INPUT_CHARACTERS + 100);
		const accepted = acceptInput(text);
		expect(countCharacters(accepted.text)).toBe(MAX_INPUT_CHARACTERS);
		expect(accepted.truncatedFrom).toBe(MAX_INPUT_CHARACTERS + 100);
	});

	it("does not split a surrogate pair when truncating", () => {
		// Fill to one short of the limit, then add an astral character at the
		// boundary: a naive slice would leave a lone surrogate.
		const text = `${"a".repeat(MAX_INPUT_CHARACTERS - 1)}😀😀`;
		const accepted = acceptInput(text);

		expect(countCharacters(accepted.text)).toBe(MAX_INPUT_CHARACTERS);
		expect(accepted.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it("explains the truncation to the user", () => {
		expect(truncationNotice(6000)).toContain("6000");
		expect(truncationNotice(6000)).toContain("5000");
	});
});

describe("copy", () => {
	it("reports success when the clipboard accepts the write", async () => {
		const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
		await expect(copyPlainText("译文", clipboard)).resolves.toEqual({
			kind: "copied",
		});
		expect(clipboard.writeText).toHaveBeenCalledWith("译文");
	});

	it("reports unsupported when there is no clipboard", async () => {
		const outcome = await copyPlainText("译文", undefined);
		expect(outcome.kind).toBe("unsupported");
		if (outcome.kind === "unsupported") {
			// The user must be told how to copy manually rather than seeing nothing.
			expect(outcome.message).toContain("手动");
		}
	});

	it("reports a降级 message when the write is rejected", async () => {
		const clipboard = {
			writeText: vi.fn().mockRejectedValue(new Error("denied")),
		};
		const outcome = await copyPlainText("译文", clipboard);
		expect(outcome.kind).toBe("unsupported");
	});

	it("does not throw when the clipboard rejects", async () => {
		const clipboard = {
			writeText: vi.fn().mockRejectedValue(new Error("denied")),
		};
		await expect(copyPlainText("x", clipboard)).resolves.toBeDefined();
	});

	it("uses a two second confirmation window", () => {
		expect(COPY_FEEDBACK_MS).toBe(2000);
	});
});

describe("copy content matches the rendered segments", () => {
	it("copies exactly the segment text", () => {
		// The copy path rebuilds from the same segments the view renders, so the
		// clipboard cannot drift from what the user sees.
		const segments = segmentTranslation("Hello.\n\nWorld.");
		expect(toPlainText(segments)).toBe("Hello.\n\nWorld.");
	});

	it("copies no Markdown even when the model emitted some", () => {
		const segments = segmentTranslation("**Bold** sentence.\n\n`code` here.");
		const copied = toPlainText(segments);
		expect(copied).not.toContain("**");
		expect(copied).not.toContain("`");
	});
});
