import { describe, expect, it } from "vitest";

import { fromQueryString, MAX_URL_TEXT_LENGTH, PARAM_TEXT } from "../url-state";
import {
	buildMailtoLink,
	buildShareLink,
	buildSocialLink,
	isShareCancellation,
	planShareChannels,
	shareMessage,
} from "./index";

const base = { sourceLang: "auto", targetLang: "zh-Hans", mode: "translate" };

describe("share link", () => {
	it("uses the workspace parameter names", () => {
		const link = buildShareLink({ ...base, text: "hello" });
		// Same names as the workspace URL: the receiver's link must be handled by
		// the existing URL restoration, not by a second scheme.
		expect(link.url).toContain("sl=auto");
		expect(link.url).toContain("tl=zh-Hans");
		expect(link.url).toContain("op=translate");
	});

	it("round-trips through the workspace parser", () => {
		const link = buildShareLink({ ...base, text: "hello world" });
		const parsed = fromQueryString(link.url);

		expect(parsed.text).toBe("hello world");
		expect(parsed.sourceLang).toBe("auto");
		expect(parsed.targetLang).toBe("zh-Hans");
		expect(parsed.mode).toBe("translate");
	});

	it("reports that the text is included when short enough", () => {
		const link = buildShareLink({ ...base, text: "short" });
		expect(link.includesText).toBe(true);
		expect(link.notice).toBeUndefined();
	});

	it("reports the omission and explains it when too long", () => {
		const link = buildShareLink({
			...base,
			text: "a".repeat(MAX_URL_TEXT_LENGTH + 1),
		});

		expect(link.includesText).toBe(false);
		expect(link.notice).toBeDefined();
		expect(link.notice).toContain("不包含原文");
	});

	it("does not truncate the text to fit", () => {
		// A truncated link would translate different content than the sender saw.
		const text = "x".repeat(MAX_URL_TEXT_LENGTH + 500);
		const link = buildShareLink({ ...base, text });

		expect(link.url).not.toContain(PARAM_TEXT);
		expect(link.url).not.toContain("xxxx");
		// Language state survives; only the oversized text is absent.
		expect(link.url).toContain("tl=zh-Hans");
	});

	it("agrees with the workspace threshold", () => {
		// Exactly at the limit is still publishable: the decision comes from the
		// shared helper rather than a second comparison.
		const atLimit = "a".repeat(MAX_URL_TEXT_LENGTH);
		expect(buildShareLink({ ...base, text: atLimit }).includesText).toBe(true);
	});

	it("preserves special characters through encoding", () => {
		const text = "a & b? c#d\nnewline 中文";
		const link = buildShareLink({ ...base, text });
		const parsed = fromQueryString(link.url);
		expect(parsed.text).toBe(text);
	});

	it("does not include credentials or connection details", () => {
		const link = buildShareLink({ ...base, text: "hello" });

		for (const forbidden of [
			"key",
			"token",
			"secret",
			"authorization",
			"endpoint",
			"model",
		]) {
			expect(link.url.toLowerCase()).not.toContain(forbidden);
		}
	});

	it("omits the mode when not given", () => {
		const link = buildShareLink({
			sourceLang: "auto",
			targetLang: "en",
			text: "x",
		});
		expect(link.url).not.toContain("op=");
	});

	it("accepts an origin prefix", () => {
		const link = buildShareLink(
			{ ...base, text: "hi" },
			"https://example.test",
		);
		expect(link.url.startsWith("https://example.test?")).toBe(true);
	});
});

describe("mail share", () => {
	it("carries the translation in the body", () => {
		const link = buildMailtoLink("你好世界");
		const body = decodeURIComponent(link.split("body=")[1]);
		expect(body).toContain("你好世界");
	});

	it("encodes newlines so they survive", () => {
		const link = buildMailtoLink("line1\nline2");
		expect(link).toContain("%0A");
		expect(decodeURIComponent(link.split("body=")[1])).toContain(
			"line1\nline2",
		);
	});

	it("encodes ampersands without breaking the query", () => {
		const link = buildMailtoLink("a & b");
		// An unencoded `&` would start a new mailto header and truncate the body.
		expect(link).not.toContain("a & b");
		expect(decodeURIComponent(link.split("body=")[1])).toBe("a & b");
	});

	it("uses a recognizable subject", () => {
		const link = buildMailtoLink("x");
		expect(decodeURIComponent(link)).toContain("MinTranslate");
	});

	it("is a mailto link", () => {
		expect(buildMailtoLink("x").startsWith("mailto:?")).toBe(true);
	});
});

describe("social share", () => {
	it("builds an intent link with the encoded translation", () => {
		const link = buildSocialLink("你好 & hi");
		expect(link).toContain("intent");
		expect(decodeURIComponent(link.split("text=")[1])).toBe("你好 & hi");
	});

	it("does not perform a publish itself", () => {
		// Only an intent URL is produced; nothing posts on the user's behalf.
		const link = buildSocialLink("x");
		expect(link).not.toContain("api");
		expect(link).toContain("intent");
	});
});

describe("share message", () => {
	it("is the translation itself", () => {
		expect(shareMessage("译文内容")).toBe("译文内容");
	});
});

describe("channel planning", () => {
	it("prefers the system sheet when available", () => {
		expect(planShareChannels(true).preferSystemShare).toBe(true);
	});

	it("falls back to built-in channels when unavailable", () => {
		const plan = planShareChannels(false);
		expect(plan.preferSystemShare).toBe(false);
		expect(plan.fallback).toContain("copy");
		expect(plan.fallback).toContain("mail");
		expect(plan.fallback).toContain("social");
	});

	it("keeps the built-in channels even when the sheet is preferred", () => {
		// The sheet can fail at call time, so the fallback must always exist.
		expect(planShareChannels(true).fallback).toHaveLength(3);
	});
});

describe("share cancellation", () => {
	it("treats an abort error as a cancellation", () => {
		const error = new Error("user dismissed");
		error.name = "AbortError";
		expect(isShareCancellation(error)).toBe(true);
	});

	it("treats a cancel message as a cancellation", () => {
		expect(isShareCancellation(new Error("Share canceled"))).toBe(true);
	});

	it("does not treat a genuine failure as a cancellation", () => {
		expect(isShareCancellation(new Error("no share target"))).toBe(false);
		expect(isShareCancellation(undefined)).toBe(false);
	});
});
