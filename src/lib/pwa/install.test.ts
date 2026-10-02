import { describe, expect, it } from "vitest";

import {
	createBrowserInstallEnvironment,
	describeCapabilities,
	detectPlatform,
	type InstallEnvironment,
	resolveInstallGuidance,
} from "./install";

/** Environment double; every dimension the guidance depends on is explicit. */
function environment(
	overrides: Partial<InstallEnvironment> = {},
): InstallEnvironment {
	return {
		promptAvailable: () => false,
		standalone: () => false,
		platform: () => "other",
		offlineAvailable: () => true,
		speechAvailable: () => true,
		...overrides,
	};
}

describe("install guidance", () => {
	it("offers the prompt path when the browser fires the event", () => {
		const guidance = resolveInstallGuidance(
			environment({ promptAvailable: () => true }),
		);
		expect(guidance.mode).toBe("prompt");
		expect(guidance.installed).toBe(false);
	});

	it("gives iOS the share-menu instructions instead of a dead button", () => {
		const guidance = resolveInstallGuidance(
			environment({ platform: () => "ios" }),
		);

		expect(guidance.mode).toBe("manual");
		// The event is absent on iOS, so the only honest thing is to explain the
		// manual route.
		expect(guidance.instructions).toContain("分享");
		expect(guidance.instructions).toContain("主屏幕");
	});

	it("states unsupported for browsers that cannot install", () => {
		for (const platform of ["firefox", "desktop-safari"] as const) {
			const guidance = resolveInstallGuidance(
				environment({ platform: () => platform }),
			);
			expect(guidance.mode, platform).toBe("unsupported");
			expect(guidance.unsupportedNotice, platform).toBeDefined();
		}
	});

	it("names the browsers that do work when one does not", () => {
		const guidance = resolveInstallGuidance(
			environment({ platform: () => "firefox" }),
		);
		expect(guidance.unsupportedNotice).toContain("Chrome");
	});

	it("offers a generic manual route for an unknown platform without the event", () => {
		const guidance = resolveInstallGuidance(
			environment({ platform: () => "other" }),
		);
		expect(guidance.mode).toBe("manual");
		expect(guidance.instructions).toBeDefined();
	});

	it("hides guidance entirely when already installed", () => {
		const guidance = resolveInstallGuidance(
			environment({ standalone: () => true, promptAvailable: () => true }),
		);
		expect(guidance.installed).toBe(true);
		// Even with the event available, an installed app must not ask again.
		expect(guidance.mode).toBe("unsupported");
	});
});

describe("capability description", () => {
	it("lists install, offline and speech", () => {
		const capabilities = describeCapabilities(
			environment({ promptAvailable: () => true }),
		);
		expect(capabilities.map((entry) => entry.id)).toEqual([
			"install",
			"offline",
			"speech",
		]);
	});

	it("marks each capability available in a fully capable environment", () => {
		for (const capability of describeCapabilities(
			environment({ promptAvailable: () => true }),
		)) {
			expect(capability.available, capability.id).toBe(true);
		}
	});

	it("explains that offline needs HTTPS, not that it is broken", () => {
		const capabilities = describeCapabilities(
			environment({ offlineAvailable: () => false }),
		);
		const offline = capabilities.find((entry) => entry.id === "offline");

		expect(offline?.available).toBe(false);
		// The reason must point at the environment, so the user does not read it as a defect.
		expect(offline?.reason).toContain("HTTPS");
	});

	it("explains speech unavailability as a browser limit", () => {
		const capabilities = describeCapabilities(
			environment({ speechAvailable: () => false }),
		);
		const speech = capabilities.find((entry) => entry.id === "speech");

		expect(speech?.available).toBe(false);
		expect(speech?.reason).toContain("浏览器");
	});

	it("does not offer install when already installed", () => {
		const capabilities = describeCapabilities(
			environment({ standalone: () => true, promptAvailable: () => true }),
		);
		expect(
			capabilities.find((entry) => entry.id === "install")?.available,
		).toBe(false);
	});

	it("marks install unavailable on a browser that cannot install", () => {
		const capabilities = describeCapabilities(
			environment({ platform: () => "firefox" }),
		);
		const install = capabilities.find((entry) => entry.id === "install");

		expect(install?.available).toBe(false);
		expect(install?.reason).toBeDefined();
	});
});

describe("platform detection", () => {
	it("recognizes iPhone and iPad", () => {
		expect(
			detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"),
		).toBe("ios");
		expect(
			detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"),
		).toBe("ios");
	});

	it("recognizes Android", () => {
		expect(detectPlatform("Mozilla/5.0 (Linux; Android 14) Chrome/120")).toBe(
			"android",
		);
	});

	it("recognizes Firefox", () => {
		expect(detectPlatform("Mozilla/5.0 Firefox/121.0")).toBe("firefox");
	});

	it("recognizes desktop Safari", () => {
		// No `chrome`/`chromium` token, so this is Safari and not a Chromium browser.
		expect(
			detectPlatform(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15",
			),
		).toBe("desktop-safari");
	});

	it("does not mistake Chromium for Safari", () => {
		expect(
			detectPlatform(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36",
			),
		).toBe("desktop-chromium");
	});

	it("recognizes desktop Chromium and Edge", () => {
		expect(detectPlatform("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36")).toBe(
			"desktop-chromium",
		);
		expect(
			detectPlatform("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 Edg/120"),
		).toBe("desktop-chromium");
	});

	it("falls back to other for an unknown agent", () => {
		expect(detectPlatform("SomethingElse/1.0")).toBe("other");
	});

	it("handles an empty agent string", () => {
		expect(detectPlatform("")).toBe("other");
	});
});

describe("browser environment adapter", () => {
	it("is constructible without browser globals", () => {
		// Prerendering and tests both run without a DOM.
		expect(() => createBrowserInstallEnvironment(() => false)).not.toThrow();
	});

	it("reports no prompt when the flag is false", () => {
		const environment = createBrowserInstallEnvironment(() => false);
		expect(environment.promptAvailable()).toBe(false);
	});

	it("does not crash when matchMedia is absent", () => {
		const environment = createBrowserInstallEnvironment(() => false);
		expect(() => environment.standalone()).not.toThrow();
		expect(environment.standalone()).toBe(false);
	});

	it("reports offline unavailable without a secure context", () => {
		const environment = createBrowserInstallEnvironment(() => false);
		// No secure context in the node test environment, so no worker and no offline.
		expect(environment.offlineAvailable()).toBe(false);
	});
});
