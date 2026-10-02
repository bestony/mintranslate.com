/**
 * Structured output parsing.
 *
 * The interesting cases are the ones a real model produces: fenced JSON, a
 * sentence of preamble, a bare object instead of an array, coordinates in the
 * wrong scale. Each has a decided outcome, and the split that matters is
 * {"readable"} versus {"report a failure"} — never {"silently return nothing"}.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import { isEmptyResult, parseRegions } from "./parse";

/** Region payloads used across cases. */
const ONE_REGION = [{ source: "Hello", target: "你好" }];

describe("packaging tolerance", () => {
	it("parses a bare array", () => {
		const result = parseRegions(JSON.stringify(ONE_REGION));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.regions[0].source).toBe("Hello");
		expect(result.regions[0].target).toBe("你好");
	});

	it("parses an array wrapped in a code fence", () => {
		const result = parseRegions(
			`Here you go:\n\`\`\`json\n${JSON.stringify(ONE_REGION)}\n\`\`\`\n`,
		);
		expect(result.ok).toBe(true);
	});

	it("parses an array preceded by prose", () => {
		const result = parseRegions(
			`I found the following text:\n${JSON.stringify(ONE_REGION)}`,
		);
		expect(result.ok).toBe(true);
	});

	it("accepts a single object as a one-region result", () => {
		const result = parseRegions(JSON.stringify(ONE_REGION[0]));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.regions).toHaveLength(1);
	});

	it("fails on a free-text answer with no JSON at all", () => {
		// The response the PRD forbids. Reported as a failure so the caller retries
		// and then says so, rather than showing nothing.
		const result = parseRegions("The image says Hello, which means 你好.");
		expect(result.ok).toBe(false);
	});

	it("fails on malformed JSON rather than guessing", () => {
		const result = parseRegions('[{"source": "Hello", "target": }]');
		expect(result.ok).toBe(false);
	});
});

describe("region reading", () => {
	it("keeps a region without any box", () => {
		const result = parseRegions(JSON.stringify(ONE_REGION));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.regions[0].box).toBeUndefined();
	});

	it("reads a valid normalized box", () => {
		const result = parseRegions(
			JSON.stringify([
				{
					source: "a",
					target: "b",
					box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
				},
			]),
		);
		if (!result.ok) throw new Error("expected success");
		expect(result.regions[0].box).toEqual({
			x: 0.1,
			y: 0.2,
			width: 0.3,
			height: 0.4,
		});
	});

	it("drops a box given in percentages but keeps the text", () => {
		// A model returning 0..100 is a real failure mode. Drawing it would put the
		// box far outside the image; dropping the region would lose read text.
		const result = parseRegions(
			JSON.stringify([
				{
					source: "a",
					target: "b",
					box: { x: 10, y: 20, width: 30, height: 40 },
				},
			]),
		);
		if (!result.ok) throw new Error("expected success");
		expect(result.regions[0].box).toBeUndefined();
		expect(result.regions[0].source).toBe("a");
	});

	it("drops a box with non-finite or non-numeric values", () => {
		for (const box of [
			{ x: "0.1", y: 0.2, width: 0.3, height: 0.4 },
			{ x: null, y: 0.2, width: 0.3, height: 0.4 },
			{ x: 0.1, y: 0.2, width: 0, height: 0.4 },
			{ x: 0.1, y: 0.2, width: 0.3 },
		]) {
			const result = parseRegions(
				JSON.stringify([{ source: "a", target: "b", box }]),
			);
			if (!result.ok)
				throw new Error(`expected success for ${JSON.stringify(box)}`);
			expect(result.regions[0].box, JSON.stringify(box)).toBeUndefined();
		}
	});

	it("clips a box that runs past the edge instead of dropping it", () => {
		const result = parseRegions(
			JSON.stringify([
				{
					source: "a",
					target: "b",
					box: { x: 0.8, y: 0.8, width: 0.5, height: 0.5 },
				},
			]),
		);
		if (!result.ok) throw new Error("expected success");
		const box = result.regions[0].box;
		expect(box?.width).toBeCloseTo(0.2);
		expect(box?.height).toBeCloseTo(0.2);
	});

	it("marks uncertainty only when the model says so", () => {
		const result = parseRegions(
			JSON.stringify([
				{ source: "a", target: "b", uncertain: true },
				{ source: "c", target: "d" },
				{ source: "e", target: "f", uncertain: false },
				{ source: "g", target: "h", uncertain: "yes" },
			]),
		);
		if (!result.ok) throw new Error("expected success");
		expect(result.regions.map((r) => r.uncertain)).toEqual([
			true,
			false,
			false,
			// A non-boolean is not evidence of uncertainty; treating "yes" as true
			// would flag regions the model never meant to flag.
			false,
		]);
	});

	it("assigns stable ids when the model omits them", () => {
		const result = parseRegions(JSON.stringify(ONE_REGION));
		if (!result.ok) throw new Error("expected success");
		expect(result.regions[0].id).toBe("r0");
	});

	it("keeps the model's own id when present", () => {
		const result = parseRegions(
			JSON.stringify([{ id: "region-7", source: "a", target: "b" }]),
		);
		if (!result.ok) throw new Error("expected success");
		expect(result.regions[0].id).toBe("region-7");
	});

	it("drops entries with no text at all", () => {
		const result = parseRegions(
			JSON.stringify([
				{ source: "a", target: "b" },
				{ source: "", target: "" },
				{ note: "not a region" },
			]),
		);
		if (!result.ok) throw new Error("expected success");
		expect(result.regions).toHaveLength(1);
	});

	it("keeps a region with only source text", () => {
		// Partial results happen; dropping them would hide text the model read.
		const result = parseRegions(JSON.stringify([{ source: "Hello" }]));
		if (!result.ok) throw new Error("expected success");
		expect(result.regions[0].source).toBe("Hello");
		expect(result.regions[0].target).toBe("");
	});
});

describe("empty versus unreadable", () => {
	it("treats an empty array as a valid answer meaning no text", () => {
		const result = parseRegions("[]");
		expect(result.ok).toBe(true);
		expect(isEmptyResult(result)).toBe(true);
	});

	it("treats a list of unusable entries as a failure", () => {
		// Different from an empty array: the model returned something, and none of it
		// could be read. That is a parse problem worth reporting.
		const result = parseRegions(JSON.stringify([{ foo: 1 }, { bar: 2 }]));
		expect(result.ok).toBe(false);
	});

	it("treats an empty response as a failure", () => {
		expect(parseRegions("").ok).toBe(false);
		expect(parseRegions("   ").ok).toBe(false);
	});
});
