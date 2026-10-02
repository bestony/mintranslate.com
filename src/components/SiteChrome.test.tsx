/** @vitest-environment jsdom */

import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		activeProps: _activeProps,
		activeOptions: _activeOptions,
		...rest
	}: {
		to: string;
		children?: ReactNode;
		readonly [key: string]: unknown;
	}) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
}));

vi.mock("./pwa/usePwa", () => ({
	usePwa: () => ({ canPromptInstall: false }),
}));

import { SiteHeader } from "./SiteChrome";

describe("shared navigation", () => {
	it("keeps all corpus routes reachable in a scrollable 390px-safe nav", () => {
		const html = renderToString(<SiteHeader />);
		expect(html).toContain('href="/glossary"');
		expect(html).toContain('href="/memory"');
		expect(html).toContain("overflow-x-auto");
		expect(html).toContain("min-w-max");

		const links = html.match(/<a\b[^>]*>/g) ?? [];
		expect(links.length).toBe(6);
		for (const link of links) expect(link).toContain("min-h-11");
	});
});
