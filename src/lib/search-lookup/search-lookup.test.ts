import { describe, expect, it, vi } from "vitest";

import {
	buildSearchUrl,
	canSearch,
	DEFAULT_SEARCH_ENGINE,
	openSearchUrl,
	SEARCH_ENGINES,
	searchText,
	toSearchQuery,
} from "./index";

describe("query normalization", () => {
	it("collapses newlines into spaces", () => {
		// Dropping the later lines would silently search for less than the user saw.
		expect(toSearchQuery("line1\nline2")).toBe("line1 line2");
	});

	it("collapses runs of blank lines", () => {
		expect(toSearchQuery("a\n\n\nb")).toBe("a b");
	});

	it("trims surrounding whitespace", () => {
		expect(toSearchQuery("  hello  ")).toBe("hello");
	});

	it("keeps internal single spaces", () => {
		expect(toSearchQuery("hello world")).toBe("hello world");
	});

	it("returns an empty string for blank input", () => {
		expect(toSearchQuery("   \n  ")).toBe("");
	});
});

describe("search url", () => {
	it("uses the default engine", () => {
		const url = buildSearchUrl("hello");
		expect(url).toBeDefined();
		expect(url).toContain("google.com");
	});

	it("supports the other engines", () => {
		expect(buildSearchUrl("x", "bing")).toContain("bing.com");
		expect(buildSearchUrl("x", "duckduckgo")).toContain("duckduckgo.com");
	});

	it("encodes the query", () => {
		const url = buildSearchUrl("你好 world");
		expect(url).toContain(encodeURIComponent("你好 world"));
	});

	it("does not let an ampersand truncate the query", () => {
		const url = buildSearchUrl("a & b");
		// An unencoded `&` would start a new parameter and search for `a` only.
		const query = url?.split("q=")[1];
		expect(decodeURIComponent(query ?? "")).toBe("a & b");
	});

	it("does not let a hash truncate the query", () => {
		const url = buildSearchUrl("a # b");
		expect(url).not.toContain("#");
		expect(decodeURIComponent(url?.split("q=")[1] ?? "")).toBe("a # b");
	});

	it("includes all lines of a multi-line translation", () => {
		const url = buildSearchUrl("first line\nsecond line");
		const query = decodeURIComponent(url?.split("q=")[1] ?? "");
		expect(query).toContain("first line");
		expect(query).toContain("second line");
	});

	it("returns undefined for empty input so the entry point stays disabled", () => {
		expect(buildSearchUrl("")).toBeUndefined();
		expect(buildSearchUrl("   ")).toBeUndefined();
	});

	it("reports whether a search is possible", () => {
		expect(canSearch("text")).toBe(true);
		expect(canSearch("  ")).toBe(false);
	});

	it("carries only the query", () => {
		const url = buildSearchUrl("hello") ?? "";
		// No model, endpoint, credential or history identifier may travel along.
		for (const forbidden of ["model", "endpoint", "key", "token", "id="]) {
			expect(url.toLowerCase()).not.toContain(forbidden);
		}
	});

	it("offers a documented set of engines", () => {
		expect(SEARCH_ENGINES.length).toBeGreaterThanOrEqual(1);
		expect(DEFAULT_SEARCH_ENGINE).toBe("google");
	});
});

describe("opening a search", () => {
	it("opens in a new tab with noopener and noreferrer", () => {
		const open = vi.fn();
		openSearchUrl("https://example.test/q", open);

		expect(open).toHaveBeenCalledWith(
			"https://example.test/q",
			"_blank",
			"noopener,noreferrer",
		);
	});

	it("does not navigate the current page", () => {
		const open = vi.fn();
		searchText("hello", "google", open);
		// `_blank` is what keeps the translation on screen.
		expect(open.mock.calls[0][1]).toBe("_blank");
	});

	it("reports whether a tab was opened", () => {
		const open = vi.fn();
		expect(searchText("hello", "google", open)).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("does not open anything for empty text", () => {
		const open = vi.fn();
		expect(searchText("   ", "google", open)).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});

	it("searches the translation, not the source text", () => {
		const open = vi.fn();
		searchText("译文内容", "google", open);
		const url = open.mock.calls[0][0] as string;
		expect(decodeURIComponent(url.split("q=")[1])).toBe("译文内容");
	});
});
