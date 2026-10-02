import { describe, expect, it, vi } from "vitest";

import {
	fromQueryString,
	isTextPublishable,
	MAX_URL_TEXT_LENGTH,
	stripSensitiveParams,
	toQueryString,
	writeWorkspaceUrl,
} from "./index";

describe("query serialization", () => {
	it("round-trips all four parameters", () => {
		const state = {
			sourceLang: "auto",
			targetLang: "zh-Hans",
			text: "hello",
			mode: "translate",
		};
		expect(fromQueryString(toQueryString(state))).toEqual(state);
	});

	it("round-trips text requiring URL encoding", () => {
		const state = { text: "你好 world & more?=#", targetLang: "en" };
		const parsed = fromQueryString(toQueryString(state));
		expect(parsed.text).toBe("你好 world & more?=#");
	});

	it("omits absent parameters rather than writing empty ones", () => {
		expect(toQueryString({})).toBe("");
		expect(fromQueryString("")).toEqual({});
	});

	it("tolerates a leading question mark when parsing", () => {
		expect(fromQueryString("?tl=en")).toEqual({ targetLang: "en" });
	});

	it("preserves the mode parameter", () => {
		expect(fromQueryString(toQueryString({ mode: "translate" }))).toEqual({
			mode: "translate",
		});
	});
});

describe("text length threshold", () => {
	it("publishes text at exactly the limit", () => {
		const text = "a".repeat(MAX_URL_TEXT_LENGTH);
		expect(isTextPublishable(text)).toBe(true);
		expect(toQueryString({ text })).toContain("text=");
		expect(fromQueryString(toQueryString({ text })).text).toBe(text);
	});

	it("drops text one character over the limit", () => {
		const text = "a".repeat(MAX_URL_TEXT_LENGTH + 1);
		expect(isTextPublishable(text)).toBe(false);

		const query = toQueryString({ text, targetLang: "en" });
		expect(query).not.toContain("text=");
		// The other parameters survive; only the oversized text is dropped.
		expect(fromQueryString(query)).toEqual({ targetLang: "en" });
	});

	it("drops rather than truncates", () => {
		// A truncated link would translate text the sender never saw, so the
		// parameter is removed whole.
		const text = "x".repeat(MAX_URL_TEXT_LENGTH + 500);
		const parsed = fromQueryString(toQueryString({ text }));
		expect(parsed.text).toBeUndefined();
	});

	it("uses 2000 as the decided limit", () => {
		expect(MAX_URL_TEXT_LENGTH).toBe(2000);
	});
});

describe("writeWorkspaceUrl", () => {
	function harness() {
		const history = { replaceState: vi.fn(), pushState: vi.fn() };
		const location = { pathname: "/", hash: "" };
		return { history, location };
	}

	it("uses replaceState and never pushState", () => {
		const { history, location } = harness();
		writeWorkspaceUrl({ targetLang: "en" }, history, location);

		expect(history.replaceState).toHaveBeenCalledTimes(1);
		// Calling pushState would make the back button walk through every keystroke.
		expect(history.pushState).not.toHaveBeenCalled();
	});

	it("writes a path-relative URL", () => {
		const { history, location } = harness();
		writeWorkspaceUrl(
			{ targetLang: "en", mode: "translate" },
			history,
			location,
		);

		const url = history.replaceState.mock.calls[0][2] as string;
		expect(url.startsWith("/?")).toBe(true);
		expect(url).toContain("tl=en");
		expect(url).toContain("op=translate");
	});

	it("preserves the hash", () => {
		const { history } = harness();
		writeWorkspaceUrl({ targetLang: "en" }, history, {
			pathname: "/",
			hash: "#section",
		});

		expect(history.replaceState.mock.calls[0][2]).toContain("#section");
	});

	it("is stable across repeated writes of the same state", () => {
		const { history, location } = harness();
		writeWorkspaceUrl({ targetLang: "en", text: "hi" }, history, location);
		const first = history.replaceState.mock.calls[0][2];
		writeWorkspaceUrl({ targetLang: "en", text: "hi" }, history, location);
		expect(history.replaceState.mock.calls[1][2]).toBe(first);
	});
});

describe("stripSensitiveParams", () => {
	it("removes the source text parameter", () => {
		const stripped = stripSensitiveParams(
			"/?sl=auto&tl=en&text=secret+source&op=translate",
		);
		expect(stripped).not.toContain("text=");
		expect(stripped).not.toContain("secret");
	});

	it("keeps the non-sensitive parameters", () => {
		const stripped = stripSensitiveParams("/?sl=auto&tl=en&text=secret");
		expect(stripped).toContain("sl=auto");
		expect(stripped).toContain("tl=en");
	});

	it("leaves a URL without a query untouched", () => {
		expect(stripSensitiveParams("/settings")).toBe("/settings");
	});

	it("preserves the fragment while cleaning the query", () => {
		const stripped = stripSensitiveParams("/?text=x&tl=en#anchor");
		expect(stripped).not.toContain("text=");
		expect(stripped).toContain("#anchor");
		expect(stripped).toContain("tl=en");
	});

	it("handles a URL whose only parameter is the text", () => {
		const stripped = stripSensitiveParams("/?text=only");
		expect(stripped).toBe("/");
	});

	it("removes an encoded text value without leaving fragments", () => {
		const stripped = stripSensitiveParams("/?text=%E4%BD%A0%E5%A5%BDworld");
		expect(stripped).toBe("/");
	});

	it("is idempotent", () => {
		const once = stripSensitiveParams("/?tl=en&text=x");
		expect(stripSensitiveParams(once)).toBe(once);
	});

	it("operates without any network or browser API", () => {
		// Pure string handling, so it also works in a non-browser context.
		expect(() => stripSensitiveParams("/?text=x")).not.toThrow();
	});
});
