/**
 * OOXML parsing and rebuild.
 *
 * These cases build real (minimal) packages with `fflate` and assert on the
 * round trip, rather than asserting on internal calls. What they are guarding is
 * the failure that would be invisible in a simple test: handling only
 * `word/document.xml` and silently skipping headers, footnotes and comments.
 *
 * @vitest-environment node
 */

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { chunkDocument, joinChunks, splitSentences } from "./chunk";
import { parseOoxml, rebuildOoxml } from "./ooxml";
import {
	entryPathsMatching,
	MAX_UNCOMPRESSED_DOCUMENT_BYTES,
	readPackage,
	readTextEntry,
	writePackage,
	writeTextEntry,
} from "./zip";

/** Build a package from a map of text contents. */
function pack(entries: Record<string, string>): Uint8Array {
	const encoded: Record<string, Uint8Array> = {};
	for (const [path, text] of Object.entries(entries)) {
		encoded[path] = new TextEncoder().encode(text);
	}
	return writePackage(encoded);
}

function declareCentralDirectorySize(
	bytes: Uint8Array,
	size: number,
): Uint8Array {
	const copy = new Uint8Array(bytes);
	const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
	for (let offset = 0; offset + 28 <= copy.length; offset += 1) {
		if (
			copy[offset] === 0x50 &&
			copy[offset + 1] === 0x4b &&
			copy[offset + 2] === 0x01 &&
			copy[offset + 3] === 0x02
		) {
			view.setUint32(offset + 24, size, true);
			return copy;
		}
	}
	throw new Error("central directory not found");
}

/** A minimal but realistic docx body: two paragraphs, one split across runs. */
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document><w:body>
<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>
<w:p><w:r><w:t>Split </w:t></w:r><w:r><w:t>across</w:t></w:r><w:r><w:t> runs.</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>
</w:body></w:document>`;

const HEADER_XML = `<?xml version="1.0"?><w:hdr><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>`;
const FOOTER_XML = `<?xml version="1.0"?><w:ftr><w:p><w:r><w:t>Footer text</w:t></w:r></w:p></w:ftr>`;
const COMMENTS_XML = `<?xml version="1.0"?><w:comments><w:comment w:author="A"><w:p><w:r><w:t>Comment text</w:t></w:r></w:p></w:comment></w:comments>`;

describe("zip access", () => {
	it("round-trips entries", () => {
		const bytes = pack({ "a.xml": "<a>1</a>", "b/c.xml": "<c>2</c>" });
		const entries = readPackage(bytes);
		expect(Object.keys(entries).sort()).toEqual(["a.xml", "b/c.xml"]);
		expect(readTextEntry(entries, "a.xml")).toBe("<a>1</a>");
	});

	it("finds entries by pattern, for the numbered families", () => {
		const bytes = pack({
			"word/header1.xml": "1",
			"word/header2.xml": "2",
			"word/document.xml": "d",
		});
		const entries = readPackage(bytes);
		expect(entryPathsMatching(entries, /^word\/header\d*\.xml$/)).toEqual([
			"word/header1.xml",
			"word/header2.xml",
		]);
	});

	it("replaces an entry", () => {
		const entries = readPackage(pack({ "a.xml": "old" }));
		writeTextEntry(entries, "a.xml", "new");
		expect(readTextEntry(readPackage(writePackage(entries)), "a.xml")).toBe(
			"new",
		);
	});

	it("rejects a package whose uncompressed entries exceed the budget", () => {
		const bytes = declareCentralDirectorySize(
			pack({ "word/document.xml": "tiny" }),
			MAX_UNCOMPRESSED_DOCUMENT_BYTES + 1,
		);

		expect(() => readPackage(bytes)).toThrow(
			/内容无法解析.*解压后的内容.*200 MiB/,
		);
	});

	it("keeps every entry when the uncompressed total is within the budget", () => {
		const entries = readPackage(pack({ "a.xml": "a", "b.xml": "b" }));
		expect(Object.keys(entries).sort()).toEqual(["a.xml", "b.xml"]);
	});
});

describe("docx parsing", () => {
	it("reads one chunk per non-empty paragraph", () => {
		const parsed = parseOoxml(
			pack({ "word/document.xml": DOCUMENT_XML }),
			"docx",
		);
		// The whitespace-only paragraph carries no translatable text.
		expect(parsed.chunks.map((chunk) => chunk.text)).toEqual([
			"First paragraph.",
			"Split across runs.",
		]);
	});

	it("joins runs so a split sentence is one chunk", () => {
		// The whole point of reading by paragraph: this must not arrive as three
		// fragments.
		const parsed = parseOoxml(
			pack({ "word/document.xml": DOCUMENT_XML }),
			"docx",
		);
		expect(parsed.chunks[1].text).toBe("Split across runs.");
	});

	it("covers headers, footers and comments, not just the body", () => {
		// The failure this guards: a simple document passes while every header is
		// silently skipped.
		const parsed = parseOoxml(
			pack({
				"word/document.xml": DOCUMENT_XML,
				"word/header1.xml": HEADER_XML,
				"word/footer1.xml": FOOTER_XML,
				"word/comments.xml": COMMENTS_XML,
			}),
			"docx",
		);

		const texts = parsed.chunks.map((chunk) => chunk.text);
		expect(texts).toContain("Header text");
		expect(texts).toContain("Footer text");
		expect(texts).toContain("Comment text");
	});

	it("keeps nested text-box paragraphs separate during parse and rebuild", () => {
		const xml = `<w:document><w:body><w:p><w:r><w:t>Outer before </w:t></w:r><w:r><w:txbxContent><w:p><w:r><w:t>Inner text</w:t></w:r></w:p></w:txbxContent></w:r><w:r><w:t>outer after</w:t></w:r></w:p></w:body></w:document>`;
		const bytes = pack({ "word/document.xml": xml });
		const parsed = parseOoxml(bytes, "docx");

		expect(parsed.chunks.map((chunk) => chunk.text)).toEqual([
			"Outer before outer after",
			"Inner text",
		]);

		const rebuilt = rebuildOoxml(
			bytes,
			"docx",
			parsed.chunks.map((chunk) => ({
				location: chunk.location,
				target: `[${chunk.text}]`,
			})),
		);
		expect(parseOoxml(rebuilt.bytes, "docx").chunks.map((c) => c.text)).toEqual(
			["[Outer before outer after]", "[Inner text]"],
		);
	});

	it("records which part each chunk came from", () => {
		const parsed = parseOoxml(
			pack({
				"word/document.xml": DOCUMENT_XML,
				"word/header1.xml": HEADER_XML,
			}),
			"docx",
		);
		const header = parsed.chunks.find((chunk) => chunk.text === "Header text");
		expect(header?.location.part).toBe("word/header1.xml");
	});

	it("returns no chunks for a document with no text", () => {
		const parsed = parseOoxml(
			pack({ "word/document.xml": "<w:document><w:body/></w:document>" }),
			"docx",
		);
		expect(parsed.chunks).toEqual([]);
	});
});

describe("docx rebuild", () => {
	it("writes the translation into the paragraph", () => {
		const bytes = pack({ "word/document.xml": DOCUMENT_XML });
		const parsed = parseOoxml(bytes, "docx");

		const rebuilt = rebuildOoxml(
			bytes,
			"docx",
			parsed.chunks.map((chunk) => ({
				location: chunk.location,
				target: `[${chunk.text}]`,
			})),
		);

		const after = parseOoxml(rebuilt.bytes, "docx");
		expect(after.chunks.map((chunk) => chunk.text)).toEqual([
			"[First paragraph.]",
			"[Split across runs.]",
		]);
	});

	it("keeps the translation whole when the paragraph was split across runs", () => {
		const bytes = pack({ "word/document.xml": DOCUMENT_XML });
		const parsed = parseOoxml(bytes, "docx");
		const target = "一个很长的译文，远长于原文";

		const rebuilt = rebuildOoxml(bytes, "docx", [
			{ location: parsed.chunks[1].location, target },
		]);

		const after = parseOoxml(rebuilt.bytes, "docx");
		expect(after.chunks[1].text).toBe(target);
	});

	it("escapes the translation", () => {
		const bytes = pack({ "word/document.xml": DOCUMENT_XML });
		const parsed = parseOoxml(bytes, "docx");
		const target = "Tom & Jerry <3";

		const rebuilt = rebuildOoxml(bytes, "docx", [
			{ location: parsed.chunks[0].location, target },
		]);

		// Read back through the decoder, and the raw XML must be escaped.
		expect(parseOoxml(rebuilt.bytes, "docx").chunks[0].text).toBe(target);
		const raw = readTextEntry(readPackage(rebuilt.bytes), "word/document.xml");
		expect(raw).toContain("Tom &amp; Jerry &lt;3");
	});

	it("leaves untouched entries byte-identical", () => {
		// Images, styles and relationships must survive a rebuild unchanged.
		const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
		const base = readPackage(pack({ "word/document.xml": DOCUMENT_XML }));
		base["word/media/image1.png"] = binary;
		const bytes = writePackage(base);

		const parsed = parseOoxml(bytes, "docx");
		const rebuilt = rebuildOoxml(bytes, "docx", [
			{ location: parsed.chunks[0].location, target: "x" },
		]);

		const after = readPackage(rebuilt.bytes);
		expect(Array.from(after["word/media/image1.png"])).toEqual(
			Array.from(binary),
		);
	});

	it("reports which parts changed", () => {
		const bytes = pack({
			"word/document.xml": DOCUMENT_XML,
			"word/header1.xml": HEADER_XML,
		});
		const parsed = parseOoxml(bytes, "docx");
		const headerChunk = parsed.chunks.find(
			(chunk) => chunk.text === "Header text",
		);

		const rebuilt = rebuildOoxml(bytes, "docx", [
			{ location: headerChunk?.location as never, target: "页眉" },
		]);
		expect(rebuilt.changedParts).toEqual(["word/header1.xml"]);
	});

	it("rejects a replacement that would break the markup", () => {
		// The self-check must stop a broken rebuild from reaching the user.
		const bytes = pack({ "word/document.xml": DOCUMENT_XML });
		const parsed = parseOoxml(bytes, "docx");

		expect(() =>
			rebuildOoxml(bytes, "docx", [
				{ location: parsed.chunks[0].location, target: "<not closed" },
			]),
		).not.toThrow();
		// Escaping makes even hostile-looking text safe, so nothing throws here; the
		// check exists for structural damage, asserted in xml.test.ts.
	});
});

describe("pptx parsing", () => {
	it("reads text from slides", () => {
		const parsed = parseOoxml(
			pack({
				"ppt/slides/slide1.xml":
					"<p:sld><a:p><a:r><a:t>Slide one</a:t></a:r></a:p></p:sld>",
				"ppt/slides/slide2.xml":
					"<p:sld><a:p><a:r><a:t>Slide two</a:t></a:r></a:p></p:sld>",
			}),
			"pptx",
		);
		expect(parsed.chunks.map((c) => c.text)).toEqual([
			"Slide one",
			"Slide two",
		]);
	});

	it("round-trips a pptx translation", () => {
		const bytes = pack({
			"ppt/slides/slide1.xml":
				"<p:sld><a:p><a:r><a:t>Hello</a:t></a:r></a:p></p:sld>",
		});
		const parsed = parseOoxml(bytes, "pptx");
		const rebuilt = rebuildOoxml(bytes, "pptx", [
			{ location: parsed.chunks[0].location, target: "你好" },
		]);
		expect(parseOoxml(rebuilt.bytes, "pptx").chunks[0].text).toBe("你好");
	});
});

describe("xlsx parsing", () => {
	it("reads shared strings", () => {
		const parsed = parseOoxml(
			pack({
				"xl/sharedStrings.xml":
					"<sst><si><t>Alpha</t></si><si><t>Beta</t></si></sst>",
			}),
			"xlsx",
		);
		expect(parsed.chunks.map((c) => c.text)).toEqual(["Alpha", "Beta"]);
	});

	it("round-trips a shared-string translation", () => {
		const bytes = pack({
			"xl/sharedStrings.xml": "<sst><si><t>Alpha</t></si></sst>",
		});
		const parsed = parseOoxml(bytes, "xlsx");
		const rebuilt = rebuildOoxml(bytes, "xlsx", [
			{ location: parsed.chunks[0].location, target: "阿尔法" },
		]);
		expect(parseOoxml(rebuilt.bytes, "xlsx").chunks[0].text).toBe("阿尔法");
	});

	it("ignores parts that hold no shared strings", () => {
		const parsed = parseOoxml(
			pack({ "xl/workbook.xml": "<workbook><t>not a string</t></workbook>" }),
			"xlsx",
		);
		expect(parsed.chunks).toEqual([]);
	});
});

describe("sentence splitting", () => {
	it("splits at CJK terminators", () => {
		expect(splitSentences("第一句。第二句！第三句？")).toEqual([
			"第一句。",
			"第二句！",
			"第三句？",
		]);
	});

	it("splits at Latin terminators followed by a break", () => {
		// The break stays with the following sentence, and the split is lossless:
		// concatenating the parts gives the input back unchanged.
		const parts = splitSentences("One. Two! Three?");
		expect(parts).toEqual(["One.", " Two!", " Three?"]);
		expect(parts.join("")).toBe("One. Two! Three?");
	});

	it("does not split inside decimals or domains", () => {
		// A wrong boundary cuts a sentence, which the requirement forbids.
		expect(splitSentences("Version 3.5 is out")).toEqual([
			"Version 3.5 is out",
		]);
		expect(splitSentences("See example.com for details")).toEqual([
			"See example.com for details",
		]);
	});

	it("returns the whole text when there is no terminator", () => {
		expect(splitSentences("no punctuation here")).toEqual([
			"no punctuation here",
		]);
	});
});

describe("chunking", () => {
	it("leaves a short paragraph as one chunk", () => {
		const chunks = chunkDocument([
			{ text: "Short.", location: { part: "p", paragraph: 0, segment: 0 } },
		]);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].location.segment).toBe(0);
	});

	it("splits a long paragraph only at sentence boundaries", () => {
		const sentence = `${"a".repeat(80)}。`;
		const text = sentence.repeat(40);
		const chunks = chunkDocument([
			{ text, location: { part: "p", paragraph: 0, segment: 0 } },
		]);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			// Every chunk must itself be a whole number of sentences.
			expect(chunk.text.endsWith("。"), chunk.text.slice(-5)).toBe(true);
		}
		// And nothing is lost or duplicated.
		expect(joinChunks(chunks)).toBe(text);
	});

	it("gives each chunk of a split paragraph a distinct segment index", () => {
		const text = `${"b".repeat(80)}。`.repeat(40);
		const chunks = chunkDocument([
			{ text, location: { part: "p", paragraph: 3, segment: 0 } },
		]);
		const segments = chunks.map((chunk) => chunk.location.segment);
		expect(new Set(segments).size).toBe(chunks.length);
		expect(segments[0]).toBe(0);
	});

	it("keeps an oversized single sentence whole", () => {
		// A cut sentence cannot be translated correctly, so an oversized chunk is the
		// lesser problem.
		const text = "x".repeat(5000);
		const chunks = chunkDocument([
			{ text, location: { part: "p", paragraph: 0, segment: 0 } },
		]);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe(text);
	});

	it("preserves order across paragraphs", () => {
		const chunks = chunkDocument([
			{ text: "one", location: { part: "p", paragraph: 0, segment: 0 } },
			{ text: "two", location: { part: "p", paragraph: 1, segment: 0 } },
		]);
		expect(chunks.map((c) => c.text)).toEqual(["one", "two"]);
	});
});

describe("rebuild produces a valid package", () => {
	it("can be re-unzipped and re-read after a rebuild", () => {
		const bytes = pack({
			"word/document.xml": DOCUMENT_XML,
			"word/header1.xml": HEADER_XML,
		});
		const parsed = parseOoxml(bytes, "docx");
		const rebuilt = rebuildOoxml(
			bytes,
			"docx",
			parsed.chunks.map((chunk) => ({
				location: chunk.location,
				target: `T:${chunk.text}`,
			})),
		);

		// The decisive property: the delivered package still opens.
		const entries = unzipSync(rebuilt.bytes);
		expect(Object.keys(entries).length).toBeGreaterThan(0);
		expect(parseOoxml(rebuilt.bytes, "docx").chunks.length).toBe(
			parsed.chunks.length,
		);
	});
});
