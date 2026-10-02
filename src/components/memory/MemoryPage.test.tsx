/** @vitest-environment jsdom */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryPage } from "./MemoryPage";

describe("translation memory page layout", () => {
	it("has a heading and labelled query controls", () => {
		const html = renderToString(<MemoryPage />);
		expect(html).toContain("翻译记忆");
		expect(html).toContain('id="memory-keyword"');
		expect(html).toContain('name="memory-keyword"');
		expect(html).toContain('id="memory-source-language"');
		expect(html).toContain('id="memory-target-language"');
		expect(html).toContain('id="memory-origin"');
		expect(html).toContain('id="memory-sort"');
		expect(html).toContain('id="memory-direction"');
	});

	it("gives every rendered form control an id or name and a touch target", () => {
		const html = renderToString(<MemoryPage />);
		const controls =
			html.match(/<(?:button|input|textarea|select)\b[^>]*>/g) ?? [];
		expect(controls.length).toBeGreaterThan(0);
		expect(
			controls.filter(
				(control) =>
					(control.startsWith("<input") ||
						control.startsWith("<textarea") ||
						control.startsWith("<select")) &&
					!control.includes("id=") &&
					!control.includes("name="),
			),
		).toEqual([]);
		for (const control of controls) {
			if (control.includes('type="file"')) continue;
			expect(control).toContain("min-h-11");
		}
	});

	it("hydrates without reading browser storage during the first render", async () => {
		const container = document.createElement("div");
		container.innerHTML = renderToString(<MemoryPage />);
		document.body.appendChild(container);
		const errors: string[] = [];
		await act(async () => {
			hydrateRoot(container, <MemoryPage />, {
				onRecoverableError: (error) => errors.push(String(error)),
			});
		});
		expect(errors).toEqual([]);
		container.remove();
	});
});
