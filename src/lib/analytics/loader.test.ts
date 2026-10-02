import { describe, expect, it, vi } from "vitest";

import { ANALYTICS_ENABLED_KEY, MEASUREMENT_ID_KEY } from "./config";

const SCRIPT_URL = "https://example.test/gtag.js";
/**
 * What the DOM ends up with: the vendor's snippet appends the identifier to the
 * script URL, so the injected tag carries it.
 */
const TAGGED_SCRIPT_URL = `${SCRIPT_URL}?id=G-TEST123`;

import {
	type AnalyticsDom,
	analyticsCookieNames,
	clearAnalyticsCookies,
	createAnalyticsLoader,
} from "./loader";

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

/** DOM double that records injections and holds a mutable cookie jar. */
function dom(initialCookies = "") {
	const injected: string[] = [];
	const cleared: string[] = [];
	const globals = new Map<string, unknown>();
	let cookieJar = initialCookies;

	const domLike: AnalyticsDom = {
		hasScript: (url) => injected.includes(url),
		injectScript: (url) => {
			injected.push(url);
		},
		setGlobal: (name, value) => {
			globals.set(name, value);
		},
		ensureDataLayer: () => [],
		cookies: () => cookieJar,
		clearCookie: (name) => {
			cleared.push(name);
			// Remove it from the jar so a second read reflects the cleanup.
			cookieJar = cookieJar
				.split(";")
				.map((pair) => pair.trim())
				.filter((pair) => pair.split("=")[0] !== name)
				.join("; ");
		},
	};

	return {
		dom: domLike,
		injected,
		cleared,
		globals,
		setCookies: (value: string) => {
			cookieJar = value;
		},
	};
}

describe("startup states", () => {
	it("injects nothing when no identifier is configured", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage(),
		});

		const outcome = loader.init();
		expect(outcome.loaded).toBe(false);
		expect(outcome.reason).toBe("no-identifier");
		expect(fakeDom.injected).toHaveLength(0);
	});

	it("injects nothing when the build switched analytics off", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			build: { enabled: "false" },
		});

		const outcome = loader.init();
		expect(outcome.loaded).toBe(false);
		expect(outcome.reason).toBe("disabled");
		// The build switch wins: a stored identifier must not resurrect it.
		expect(fakeDom.injected).toHaveLength(0);
	});

	it("injects nothing when the user has statistics off at startup", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({
				[MEASUREMENT_ID_KEY]: "G-TEST123",
				[ANALYTICS_ENABLED_KEY]: "false",
			}),
		});

		const outcome = loader.init();
		expect(outcome.loaded).toBe(false);
		expect(outcome.reason).toBe("disabled");
		// Opting out means no script tag at all, not "injected then disabled".
		expect(fakeDom.injected).toHaveLength(0);
	});

	it("injects the script when configured and enabled", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			scriptUrl: SCRIPT_URL,
		});

		const outcome = loader.init();
		expect(outcome.loaded).toBe(true);
		expect(fakeDom.injected).toEqual([TAGGED_SCRIPT_URL]);
	});

	it("configures the vendor global before injecting", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			scriptUrl: SCRIPT_URL,
		});
		loader.init();

		// The data layer and global must exist so the inline config calls land.
		expect(fakeDom.globals.has("gtag")).toBe(true);
	});

	it("does not inject twice", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			scriptUrl: SCRIPT_URL,
		});

		loader.init();
		loader.init();
		expect(fakeDom.injected).toHaveLength(1);
	});

	it("reports whether it is loaded", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			scriptUrl: SCRIPT_URL,
		});
		expect(loader.loaded()).toBe(false);
		loader.init();
		expect(loader.loaded()).toBe(true);
	});
});

describe("runtime toggle states", () => {
	it("stops and clears cookies when disabled at runtime", () => {
		const fakeDom = dom("_ga=GA1.1.123; _ga_ABC=GS1.1.456; unrelated=keep");
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			scriptUrl: SCRIPT_URL,
		});
		loader.init();

		loader.disable();

		expect(loader.statisticsEnabled()).toBe(false);
		// Both the base cookie and the identifier-derived variant are cleared.
		expect(fakeDom.cleared).toContain("_ga");
		expect(fakeDom.cleared).toContain("_ga_ABC");
		expect(fakeDom.cleared).not.toContain("unrelated");
	});

	it("does not load on the next init after being disabled", () => {
		const fakeDom = dom();
		const store = storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" });
		const loader = createAnalyticsLoader({ dom: fakeDom.dom, storage: store });

		loader.disable();
		const outcome = loader.init();

		// "Next load does not inject" is what the spec asks for; the toggle persisted.
		expect(outcome.loaded).toBe(false);
		expect(store.data[ANALYTICS_ENABLED_KEY]).toBe("false");
	});

	it("a fresh loader with the toggle off injects nothing", () => {
		// Simulates a reload after opting out.
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({
				[MEASUREMENT_ID_KEY]: "G-TEST123",
				[ANALYTICS_ENABLED_KEY]: "false",
			}),
		});

		expect(loader.init().loaded).toBe(false);
		expect(fakeDom.injected).toHaveLength(0);
	});

	it("injects on demand when re-enabled", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			scriptUrl: SCRIPT_URL,
		});

		loader.disable();
		expect(loader.statisticsEnabled()).toBe(false);

		loader.enable();
		expect(loader.statisticsEnabled()).toBe(true);
		expect(fakeDom.injected).toEqual([TAGGED_SCRIPT_URL]);
	});

	it("persists the toggle in both directions", () => {
		const store = storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" });
		const loader = createAnalyticsLoader({
			dom: dom().dom,
			storage: store,
			scriptUrl: SCRIPT_URL,
		});

		loader.disable();
		expect(store.data[ANALYTICS_ENABLED_KEY]).toBe("false");
		loader.enable();
		expect(store.data[ANALYTICS_ENABLED_KEY]).toBe("true");
	});

	it("does nothing to cookies when there are none", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" }),
			scriptUrl: SCRIPT_URL,
		});

		expect(() => loader.disable()).not.toThrow();
		expect(fakeDom.cleared).toHaveLength(0);
	});
});

describe("cookie handling", () => {
	it("lists only provider cookies", () => {
		const fakeDom = dom("_ga=A; _ga_XYZ=B; session=C; other=D");
		expect(analyticsCookieNames(fakeDom.dom).sort()).toEqual([
			"_ga",
			"_ga_XYZ",
		]);
	});

	it("clears the base name and derived variants", () => {
		const fakeDom = dom("_ga=A; _ga_ONE=B; _ga_TWO=C");
		const cleared = clearAnalyticsCookies(fakeDom.dom);
		expect(cleared.sort()).toEqual(["_ga", "_ga_ONE", "_ga_TWO"]);
	});

	it("leaves unrelated cookies alone", () => {
		const fakeDom = dom("unrelated=1; _ga=A");
		clearAnalyticsCookies(fakeDom.dom);
		expect(fakeDom.cleared).toEqual(["_ga"]);
	});

	it("handles an empty cookie string", () => {
		const fakeDom = dom("");
		expect(clearAnalyticsCookies(fakeDom.dom)).toEqual([]);
	});

	it("tolerates cookies with no value", () => {
		const fakeDom = dom("_ga");
		expect(analyticsCookieNames(fakeDom.dom)).toEqual(["_ga"]);
	});
});

describe("independence from other local data", () => {
	it("clearing analytics cookies does not touch unrelated local storage", () => {
		const store = storage({
			[MEASUREMENT_ID_KEY]: "G-TEST123",
			"mintranslate.history.v1": "keep me",
			"mintranslate.connections.v1": '{"a":1}',
		});
		const loader = createAnalyticsLoader({
			dom: dom("_ga=A").dom,
			storage: store,
		});

		loader.disable();

		// Opting out of analytics is not a request to delete the user's own data.
		expect(store.data["mintranslate.history.v1"]).toBe("keep me");
		expect(store.data["mintranslate.connections.v1"]).toBe('{"a":1}');
	});

	it("keeps the identifier so re-enabling does not need it retyped", () => {
		const store = storage({ [MEASUREMENT_ID_KEY]: "G-TEST123" });
		const loader = createAnalyticsLoader({
			dom: dom().dom,
			storage: store,
			scriptUrl: SCRIPT_URL,
		});
		loader.disable();
		expect(store.data[MEASUREMENT_ID_KEY]).toBe("G-TEST123");
	});
});

describe("no identifier means no requests regardless of the toggle", () => {
	it("injects nothing with the toggle on", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage(),
		});
		loader.init();
		expect(fakeDom.injected).toHaveLength(0);
	});

	it("injects nothing with the toggle off", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage({ [ANALYTICS_ENABLED_KEY]: "false" }),
		});
		loader.init();
		expect(fakeDom.injected).toHaveLength(0);
	});

	it("does not inject when enabling with no identifier", () => {
		const fakeDom = dom();
		const loader = createAnalyticsLoader({
			dom: fakeDom.dom,
			storage: storage(),
		});
		loader.enable();
		expect(fakeDom.injected).toHaveLength(0);
	});
});

describe("browser dom adapter", () => {
	it("is created without touching the document", async () => {
		// The adapter must be constructible in a non-browser context (tests, prerender).
		const { createBrowserDom } = await import("./loader");
		expect(() => createBrowserDom()).not.toThrow();
	});

	it("reports no script and no cookies without a document", async () => {
		const { createBrowserDom } = await import("./loader");
		const browserDom = createBrowserDom();
		expect(browserDom.hasScript("https://example.test/a.js")).toBe(false);
		expect(browserDom.cookies()).toBe("");
	});

	it("does not throw when injecting without a document", async () => {
		const { createBrowserDom } = await import("./loader");
		const browserDom = createBrowserDom();
		expect(() =>
			browserDom.injectScript("https://example.test/a.js", "id"),
		).not.toThrow();
		expect(() => browserDom.clearCookie("_ga")).not.toThrow();
	});
});

describe("spy sanity", () => {
	it("records injections as calls for later assertions", () => {
		const inject = vi.fn();
		inject("x");
		expect(inject).toHaveBeenCalledWith("x");
	});
});
