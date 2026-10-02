/**
 * XML text scanning.
 *
 * This module carries the change's main correctness risk: a translation containing
 * `&`, `<` or `>` that is written unescaped produces a document that no longer
 * parses, and the failure would surface only when the user tries to open the file.
 *
 * So the escaping cases are enumerated rather than sampled, and every case asserts
 * the round trip: read → replace → read again gives back what was written.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";

import {
	decodeXmlText,
	distributeAcrossSpans,
	escapeXmlText,
	findTextSpans,
	isWellFormed,
	joinSpans,
	replaceTextSpans,
} from "./xml";

describe("escaping", () => {
	it("escapes the three characters that must be escaped", () => {
		expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
	});

	it("escapes the ampersand first, not its own output", () => {
		// Escaping '<' before '&' would turn `&lt;` into `&amp;lt;`.
		expect(escapeXmlText("<")).toBe("&lt;");
		expect(escapeXmlText("&lt;")).toBe("&amp;lt;");
	});

	it("decodes named entities", () => {
		for (const [input, expected] of [
			["&amp;", "&"],
			["&lt;", "<"],
			["&gt;", ">"],
			["&quot;", '"'],
			["&apos;", "'"],
		] as const) {
			expect(decodeXmlText(input), input).toBe(expected);
		}
	});

	it("decodes numeric and hexadecimal entities", () => {
		expect(decodeXmlText("&#65;&#x42;")).toBe("AB");
		expect(decodeXmlText("&#x4e2d;")).toBe("中");
	});

	it("leaves unknown entities alone instead of dropping them", () => {
		// A document using a DTD entity must round-trip, not lose the reference.
		expect(decodeXmlText("&nbsp;&custom;")).toBe("&nbsp;&custom;");
	});

	it("round-trips text containing the characters that break XML", () => {
		// Quotes need no escaping in XML character data, but they are included because
		// a translation containing them is common and must survive the round trip.
		const values = ["a & b", "<tag>", "5 > 3", "&amp;", "a &lt; b"];
		values.push(`quote " and ' mixed`);

		for (const value of values) {
			const xml = `<t>${escapeXmlText(value)}</t>`;
			const [span] = findTextSpans(xml, "t");
			expect(span.text, value).toBe(value);
		}
	});
});

describe("finding text elements", () => {
	it("finds paired elements", () => {
		const spans = findTextSpans("<t>one</t><t>two</t>", "t");
		expect(spans.map((s) => s.text)).toEqual(["one", "two"]);
	});

	it("finds elements that carry attributes", () => {
		// `xml:space="preserve"` is how OOXML keeps leading spaces.
		const spans = findTextSpans('<w:t xml:space="preserve"> hi </w:t>', "w:t");
		expect(spans[0].text).toBe(" hi ");
	});

	it("finds empty paired elements", () => {
		const spans = findTextSpans("<t></t>", "t");
		expect(spans).toHaveLength(1);
		expect(spans[0].text).toBe("");
	});

	it("marks self-closing elements as having no content", () => {
		const spans = findTextSpans("<t/><t>x</t>", "t");
		expect(spans.filter((s) => s.selfClosing)).toHaveLength(1);
		expect(spans.filter((s) => !s.selfClosing)).toHaveLength(1);
	});

	it("does not match a different element whose name ends the same way", () => {
		const spans = findTextSpans("<w:t>a</w:t><w:tab/>", "w:t");
		expect(spans).toHaveLength(1);
		expect(spans[0].text).toBe("a");
	});

	it("does not match a longer name that starts the same way", () => {
		const spans = findTextSpans("<w:tbl><w:t>a</w:t></w:tbl>", "w:t");
		expect(spans).toHaveLength(1);
	});

	it("unwraps CDATA", () => {
		const spans = findTextSpans("<t><![CDATA[a & b < c]]></t>", "t");
		expect(spans[0].text).toBe("a & b < c");
	});

	it("returns spans in document order", () => {
		const spans = findTextSpans("<t>1</t><t>2</t><t>3</t>", "t");
		expect(spans.map((s) => s.text)).toEqual(["1", "2", "3"]);
		expect(spans[0].start).toBeLessThan(spans[1].start);
	});

	it("handles an element with no matches", () => {
		expect(findTextSpans("<x>a</x>", "t")).toEqual([]);
	});
});

describe("replacing text", () => {
	it("replaces a single element", () => {
		const xml = "<t>old</t>";
		const [span] = findTextSpans(xml, "t");
		expect(replaceTextSpans(xml, [{ span, value: "new" }])).toBe("<t>new</t>");
	});

	it("replaces several elements without offset drift", () => {
		// Applied back to front; forwards, each edit would shift the next span.
		const xml = "<t>short</t><t>also short</t>";
		const spans = findTextSpans(xml, "t");
		const result = replaceTextSpans(xml, [
			{ span: spans[0], value: "a much longer replacement" },
			{ span: spans[1], value: "x" },
		]);
		expect(result).toBe("<t>a much longer replacement</t><t>x</t>");
	});

	it("escapes what it writes", () => {
		const xml = "<t>old</t>";
		const [span] = findTextSpans(xml, "t");
		const result = replaceTextSpans(xml, [{ span, value: "tom & jerry <3" }]);
		expect(result).toBe("<t>tom &amp; jerry &lt;3</t>");
		// And reading it back gives the original text.
		expect(findTextSpans(result, "t")[0].text).toBe("tom & jerry <3");
	});

	it("can empty an element", () => {
		const xml = "<t>old</t>";
		const [span] = findTextSpans(xml, "t");
		expect(replaceTextSpans(xml, [{ span, value: "" }])).toBe("<t></t>");
	});

	it("ignores a self-closing element, which has no content to replace", () => {
		const xml = "<t/><t>x</t>";
		const [selfClosed] = findTextSpans(xml, "t");
		expect(replaceTextSpans(xml, [{ span: selfClosed, value: "y" }])).toBe(xml);
	});

	it("leaves the surrounding markup untouched", () => {
		const xml = '<w:p><w:r><w:t xml:space="preserve">old</w:t></w:r></w:p>';
		const [span] = findTextSpans(xml, "w:t");
		expect(replaceTextSpans(xml, [{ span, value: "new" }])).toBe(
			'<w:p><w:r><w:t xml:space="preserve">new</w:t></w:r></w:p>',
		);
	});
});

describe("paragraph assembly across runs", () => {
	it("joins the spans a sentence was split into", () => {
		// The reason runs are read together: a word split across runs must not be
		// translated as fragments.
		const xml =
			"<w:p><w:r><w:t>Inter</w:t></w:r><w:r><w:t>national</w:t></w:r><w:r><w:t>ization</w:t></w:r></w:p>";
		const spans = findTextSpans(xml, "w:t");
		expect(joinSpans(spans)).toBe("Internationalization");
	});

	it("puts the whole translation in the first run and empties the rest", () => {
		const xml = "<w:t>one</w:t><w:t>two</w:t><w:t>three</w:t>";
		const spans = findTextSpans(xml, "w:t");
		const distribution = distributeAcrossSpans(spans, "translated");

		expect(distribution.map((d) => d.value)).toEqual(["translated", "", ""]);
		const result = replaceTextSpans(xml, distribution);
		expect(findTextSpans(result, "w:t").map((s) => s.text)).toEqual([
			"translated",
			"",
			"",
		]);
	});

	it("keeps the translation whole even when longer than the original", () => {
		const xml = "<w:t>a</w:t><w:t>b</w:t>";
		const spans = findTextSpans(xml, "w:t");
		const result = replaceTextSpans(
			xml,
			distributeAcrossSpans(spans, "a much longer translation"),
		);
		// Reassembling what a reader would see must give the full translation.
		expect(joinSpans(findTextSpans(result, "w:t"))).toBe(
			"a much longer translation",
		);
	});

	it("does nothing when there is nowhere to write", () => {
		expect(distributeAcrossSpans([], "x")).toEqual([]);
	});
});

describe("well-formedness check", () => {
	it("accepts balanced markup", () => {
		expect(isWellFormed("<a><b>x</b></a>")).toBe(true);
		expect(isWellFormed("<a><b/></a>")).toBe(true);
		expect(isWellFormed("<?xml version='1.0'?><a>x</a>")).toBe(true);
		expect(isWellFormed('<a xml:space="preserve">x</a>')).toBe(true);
	});

	it("rejects an unclosed tag", () => {
		expect(isWellFormed("<a><b>x</a>")).toBe(false);
	});

	it("rejects a dangling open tag", () => {
		expect(isWellFormed("<a><b>x</b>")).toBe(false);
	});

	it("catches what a bad replacement would look like", () => {
		// A replacement that escaped nothing would leave this unbalanced.
		const xml = "<t>a & b < c</t>";
		expect(isWellFormed(xml)).toBe(false);

		const [span] = findTextSpans("<t>old</t>", "t");
		const fixed = replaceTextSpans("<t>old</t>", [
			{ span, value: "a & b < c" },
		]);
		expect(isWellFormed(fixed)).toBe(true);
	});
});
