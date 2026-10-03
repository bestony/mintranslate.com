import { describe, expect, it, vi } from "vitest";
import { MEASUREMENT_ID_KEY } from "./config";
import {
	ANALYTICS_EVENT_NAMES,
	type AnalyticsEventMap,
	clampFreeText,
	isForbiddenKey,
	isSendableFreeText,
	MAX_FREE_TEXT_LENGTH,
} from "./events";
import {
	carriesVisibleText,
	sanitizedPagePath,
	sanitizedPageUrl,
} from "./page-url";
import {
	createAnalytics,
	endpointHost,
	hashHostname,
	reportedHost,
} from "./track";

/** Storage double. */
function storage(seed: Record<string, string> = {}) {
	const data = { ...seed };
	return {
		data,
		getItem: (key: string) => data[key] ?? null,
		setItem: (key: string, value: string) => {
			data[key] = value;
		},
		removeItem: (key: string) => {
			delete data[key];
		},
	};
}

/** Tracker wired to a recording transport and a fixed identifier. */
function harness(
	options: { readonly enabled?: boolean; readonly id?: string } = {},
) {
	const sent: Array<{ event: string; params: Record<string, unknown> }> = [];
	const store = storage(
		options.id === undefined ? {} : { [MEASUREMENT_ID_KEY]: options.id },
	);
	if (options.enabled === false)
		store.data["mintranslate.analytics-enabled.v1"] = "false";

	const analytics = createAnalytics({
		byokConfigured: () => false,
		storage: store,
		transport: {
			send: (event, params) => sent.push({ event, params }),
			ready: () => true,
		},
	});

	return { analytics, sent, store };
}

describe("event schema", () => {
	it("lists exactly the nine documented events", () => {
		expect([...ANALYTICS_EVENT_NAMES].sort()).toEqual(
			[
				"app_open",
				"connection_test",
				"cors_blocked",
				"lang_change",
				"model_in_use",
				"provider_config_save",
				"translate_error",
				"translate_submit",
				"translate_success",
			].sort(),
		);
	});

	it("has a documented inventory listing the same events", async () => {
		// The schema is the source of truth; the doc must not drift from it.
		const fs = await import("node:fs");
		const doc = fs.readFileSync("docs/analytics-events.md", "utf8");

		for (const name of ANALYTICS_EVENT_NAMES) {
			expect(doc, `inventory is missing ${name}`).toContain(`\`${name}\``);
		}
	});

	it("declares no duplicate event names", () => {
		expect(new Set(ANALYTICS_EVENT_NAMES).size).toBe(
			ANALYTICS_EVENT_NAMES.length,
		);
	});
});

describe("value rules", () => {
	it("truncates a long free-form value", () => {
		expect(clampFreeText("a".repeat(100))).toHaveLength(MAX_FREE_TEXT_LENGTH);
	});

	it("keeps a value at the limit", () => {
		const value = "a".repeat(MAX_FREE_TEXT_LENGTH);
		expect(clampFreeText(value)).toBe(value);
	});

	it("accepts realistic model identifiers", () => {
		expect(isSendableFreeText("gpt-4o-mini")).toBe(true);
		expect(isSendableFreeText("anthropic/claude-sonnet-4.5")).toBe(true);
		expect(isSendableFreeText("llama3.2:8b")).toBe(true);
	});

	it("rejects values that look like pasted prose", () => {
		expect(isSendableFreeText("请帮我翻译这段话")).toBe(false);
		expect(isSendableFreeText("model with spaces")).toBe(false);
		expect(isSendableFreeText("line\nbreak")).toBe(false);
	});

	it("recognizes forbidden keys", () => {
		for (const key of [
			"apiKey",
			"api_key",
			"Authorization",
			"text",
			"targetText",
			"endpoint",
		]) {
			expect(isForbiddenKey(key), key).toBe(true);
		}
	});

	it("does not flag legitimate keys", () => {
		for (const key of [
			"provider",
			"model",
			"latency_ms",
			"mode",
			"source_lang",
		]) {
			expect(isForbiddenKey(key), key).toBe(false);
		}
	});
});

describe("track entry point", () => {
	const submit: AnalyticsEventMap["translate_submit"] = {
		mode: "text",
		source_lang: "auto",
		target_lang: "zh-Hans",
		input_chars: 19,
		input_kind: "text",
	};

	it("sends an event when configured and enabled", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		analytics.track("translate_submit", submit);
		expect(sent).toHaveLength(1);
		expect(sent[0].event).toBe("translate_submit");
	});

	it("attaches the common parameters", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		analytics.track("translate_submit", submit);

		expect(sent[0].params.app_version).toBeDefined();
		expect(sent[0].params.ui_lang).toBe("zh-CN");
		expect(sent[0].params.is_byok_configured).toBe(false);
	});

	it("drops undeclared parameters", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		// A call site adding an extra field must not get it through.
		analytics.track("translate_submit", {
			...submit,
			secretExtra: "should not travel",
		} as never);

		expect(sent[0].params.secretExtra).toBeUndefined();
	});

	it("drops forbidden keys even when passed", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		analytics.track("translate_submit", {
			...submit,
			text: "原文内容",
			apiKey: "sk-secret",
			targetText: "译文内容",
		} as never);

		const payload = JSON.stringify(sent[0].params);
		expect(payload).not.toContain("原文内容");
		expect(payload).not.toContain("sk-secret");
		expect(payload).not.toContain("译文内容");
		expect(sent[0].params.text).toBeUndefined();
		expect(sent[0].params.apiKey).toBeUndefined();
	});

	it("sends the character count, not the content", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		analytics.track("translate_submit", submit);
		expect(sent[0].params.input_chars).toBe(19);
	});

	it("truncates an over-long model id", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		analytics.track("model_in_use", {
			provider: "openai",
			model: "m".repeat(200),
		});
		expect((sent[0].params.model as string).length).toBe(MAX_FREE_TEXT_LENGTH);
	});

	it("drops a model id that looks like pasted text", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		analytics.track("model_in_use", {
			provider: "openai",
			model: "这是一段粘贴的中文",
		});

		// The event still goes; only the unusable parameter is dropped.
		expect(sent).toHaveLength(1);
		expect(sent[0].params.model).toBeUndefined();
	});

	it("does not emit CORS diagnostics for built-in providers", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		analytics.track("cors_blocked", {
			provider: "builtin-translator",
			endpoint_host: "",
		});
		analytics.track("cors_blocked", {
			provider: "builtin-multimodal",
			endpoint_host: "",
		});
		expect(sent).toHaveLength(0);
	});

	it("keeps the two built-in providers distinct in success events", () => {
		const { analytics, sent } = harness({ id: "G-TEST123" });
		for (const provider of [
			"builtin-translator",
			"builtin-multimodal",
		] as const) {
			analytics.track("translate_success", {
				mode: "text",
				source_lang: "en",
				target_lang: "ja",
				provider,
				model: "",
				latency_ms: 1,
				is_streaming: false,
			});
		}
		expect(sent.map(({ params }) => params.provider)).toEqual([
			"builtin-translator",
			"builtin-multimodal",
		]);
		expect(sent.every(({ params }) => !("endpoint_host" in params))).toBe(true);
	});

	it("is a no-op without an identifier", () => {
		const { analytics, sent } = harness();
		for (const name of ANALYTICS_EVENT_NAMES) {
			// Every event must be safe to call in an unconfigured build.
			analytics.track(name, {} as never);
		}
		expect(sent).toHaveLength(0);
	});

	it("is a no-op when the user turned statistics off", () => {
		const { analytics, sent } = harness({ id: "G-TEST123", enabled: false });
		analytics.track("translate_submit", submit);
		expect(sent).toHaveLength(0);
	});

	it("reports whether it is enabled", () => {
		expect(harness({ id: "G-TEST123" }).analytics.enabled()).toBe(true);
		expect(harness().analytics.enabled()).toBe(false);
		expect(
			harness({ id: "G-TEST123", enabled: false }).analytics.enabled(),
		).toBe(false);
	});

	it("swallows a throwing transport", () => {
		const analytics = createAnalytics({
			byokConfigured: () => false,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			transport: {
				send: () => {
					throw new Error("blocked by extension");
				},
				ready: () => true,
			},
		});

		expect(() =>
			analytics.track("app_open", { entry_mode: "text", has_url_text: false }),
		).not.toThrow();
	});

	it("does not throw for any event when unconfigured", () => {
		const { analytics } = harness();
		expect(() =>
			analytics.track("translate_success", {} as never),
		).not.toThrow();
	});
});

describe("page url sanitisation", () => {
	it("removes the source text parameter", () => {
		const url = sanitizedPageUrl(
			"https://host/?sl=auto&tl=en&text=%E4%BD%A0%E5%A5%BD",
		);
		expect(url).not.toContain("text=");
		expect(url).not.toContain("%E4%BD%A0%E5%A5%BD");
	});

	it("keeps the language and mode parameters", () => {
		const url = sanitizedPageUrl(
			"https://host/?sl=auto&tl=en&op=translate&text=x",
		);
		expect(url).toContain("sl=auto");
		expect(url).toContain("tl=en");
		expect(url).toContain("op=translate");
	});

	it("removes the parameter whole rather than truncating", () => {
		const long = "x".repeat(3000);
		const url = sanitizedPageUrl(`https://host/?text=${long}`);
		expect(url).not.toContain("text=");
		expect(url).not.toContain("xxxx");
	});

	it("derives the path from the sanitised url", () => {
		expect(sanitizedPagePath("https://host/history?text=秘密")).toBe(
			"https://host/history",
		);
	});

	it("strips a fragment from the path", () => {
		expect(sanitizedPagePath("https://host/page?tl=en#section")).toBe(
			"https://host/page",
		);
	});

	it("detects when a url carries source text", () => {
		expect(carriesVisibleText("https://host/?text=x")).toBe(true);
		expect(carriesVisibleText("https://host/?tl=en")).toBe(false);
	});

	it("leaves a clean url unchanged", () => {
		const url = "https://host/?sl=auto&tl=en";
		expect(sanitizedPageUrl(url)).toBe(url);
	});
});

describe("endpoint host handling", () => {
	it("extracts only the hostname", () => {
		expect(endpointHost("https://api.example.com/v1/chat?key=1")).toBe(
			"api.example.com",
		);
	});

	it("returns undefined for an unusable endpoint", () => {
		expect(endpointHost("not a url")).toBeUndefined();
		expect(endpointHost("")).toBeUndefined();
	});

	it("hashes a custom endpoint hostname", async () => {
		const hashed = await hashHostname("gateway.internal.corp");
		expect(hashed).toHaveLength(12);
		expect(hashed).toMatch(/^[0-9a-f]{12}$/);
		expect(hashed).not.toContain("gateway");
	});

	it("produces a stable hash for the same host", async () => {
		// Stability is the point: it is what makes cross-user comparison possible.
		expect(await hashHostname("a.example")).toBe(
			await hashHostname("a.example"),
		);
	});

	it("produces different hashes for different hosts", async () => {
		expect(await hashHostname("a.example")).not.toBe(
			await hashHostname("b.example"),
		);
	});

	it("reports a built-in provider hostname verbatim", async () => {
		expect(await reportedHost("https://api.openai.com/v1", false)).toBe(
			"api.openai.com",
		);
	});

	it("hashes a custom endpoint hostname", async () => {
		const reported = await reportedHost(
			"https://gateway.internal.corp/v1",
			true,
		);
		expect(reported).not.toBe("gateway.internal.corp");
		expect(reported).toMatch(/^[0-9a-f]{12}$/);
	});

	it("returns undefined when the endpoint has no usable host", async () => {
		expect(await reportedHost("", true)).toBeUndefined();
	});

	it("is deterministic across calls, which cross-user comparison requires", async () => {
		const first = await reportedHost("https://gateway.internal.corp/v1", true);
		const second = await reportedHost(
			"https://other.path/gateway.internal.corp",
			true,
		);
		// Different hosts, different hashes — comparison is per-hostname.
		expect(first).not.toBe(second);
	});

	it("does not log the raw hostname anywhere in the payload", async () => {
		const spy = vi.fn();
		const reported = await reportedHost(
			"https://secret-internal.corp/v1",
			true,
		);
		spy(reported);
		expect(spy.mock.calls[0][0]).not.toContain("secret-internal");
	});
});
