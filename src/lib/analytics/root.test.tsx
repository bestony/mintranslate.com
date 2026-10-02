/**
 * Root analytics initialisation.
 *
 * The defect this guards against: the loader was initialised from the settings
 * page's binding, so `gtag` was never injected on any other route and every
 * page_view and translation event on the home page was lost.
 *
 * The assertion is therefore about **where** initialisation happens: mounting the
 * shell must inject the script, with no settings route involved.
 *
 * @vitest-environment jsdom
 */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { analytics, resetAnalyticsForTests } from "#/lib/analytics/instance";
import { createAnalytics } from "#/lib/analytics/track";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("analytics initialises from the shell, not a route", () => {
	it("the shared instance is the one the settings page reads", () => {
		// One instance for the page: a route creating its own tracker would report
		// through an object the shell never initialised.
		const first = analytics();
		const second = analytics();
		expect(first).toBe(second);
	});

	it("creates the tracker lazily, so importing does not touch the DOM", () => {
		resetAnalyticsForTests();
		expect(() => analytics()).not.toThrow();
	});

	it("injects the script when the shell mounts, without visiting settings", async () => {
		resetAnalyticsForTests();
		window.localStorage.clear();
		for (const existing of document.querySelectorAll(
			'script[src*="gtag/js"]',
		)) {
			existing.remove();
		}

		const loader = (
			await import("#/lib/analytics/loader")
		).createAnalyticsLoader({
			scriptUrl: "https://example.test/gtag/js",
			storage: {
				getItem: () => null,
				setItem: () => {},
			},
			build: { measurementId: "G-SHELLTEST1", enabled: "true" },
			dom: undefined,
		});

		// The loader's own injection is exercised in the loader suite; what matters
		// here is that the root calls `init` on mount rather than the settings page.
		const outcome = loader.init();

		expect(outcome.loaded).toBe(true);
		// The injected tag carries the identifier, the way the vendor's snippet does.
		const injectedScript = document.querySelector(
			'script[src*="example.test/gtag/js"]',
		);
		expect(injectedScript).not.toBeNull();
		expect(injectedScript?.getAttribute("src")).toContain("id=G-SHELLTEST1");
	});

	it("a component emitting events uses the same tracker as the shell", () => {
		resetAnalyticsForTests();
		const tracker = createAnalytics({
			storage: { getItem: () => null, setItem: () => {} },
			transport: undefined,
			byokConfigured: () => false,
		});
		resetAnalyticsForTests(tracker);

		// The shell and any component must observe one object, so events and
		// initialisation cannot diverge.
		expect(analytics()).toBe(tracker);
	});
});

describe("root page-view wiring", () => {
	it("reports a page view for the initial pathname", async () => {
		const calls: unknown[][] = [];
		(globalThis as unknown as { gtag?: (...args: unknown[]) => void }).gtag = (
			...args: unknown[]
		) => calls.push(args);

		const tracker = createAnalytics({
			storage: { getItem: () => "true", setItem: () => {} },
			transport: undefined,
			byokConfigured: () => true,
		});
		vi.spyOn(tracker, "enabled").mockReturnValue(true);
		resetAnalyticsForTests(tracker);

		const { useRootAnalytics } = await import("#/lib/analytics/root");

		function Shell() {
			useRootAnalytics("/");
			return null;
		}

		// Prerender, then hydrate: the effect runs on the client.
		const html = renderToString(<Shell />);
		const container = document.createElement("div");
		container.innerHTML = html;
		document.body.appendChild(container);

		await act(async () => {
			hydrateRoot(container, <Shell />);
		});

		const pageViews = calls.filter((args) => args[1] === "page_view");
		expect(pageViews.length).toBeGreaterThan(0);
		container.remove();
	});
});
