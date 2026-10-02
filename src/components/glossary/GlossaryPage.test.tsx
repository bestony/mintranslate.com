/** @vitest-environment jsdom */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GlossaryPage } from "./GlossaryPage";

describe("glossary page layout", () => {
	it("has a main heading and labelled controls", () => {
		const html = renderToString(<GlossaryPage />);
		expect(html).toContain("术语表");
		expect(html).toContain('id="glossary-source-filter"');
		expect(html).toContain('name="glossary-source-filter"');
		expect(html).toContain('id="glossary-keyword"');
		expect(html).toContain('name="glossary-keyword"');
	});

	it("hydrates without browser storage during the first render", async () => {
		const container = document.createElement("div");
		container.innerHTML = renderToString(<GlossaryPage />);
		document.body.appendChild(container);
		const errors: string[] = [];
		await act(async () => {
			hydrateRoot(container, <GlossaryPage />, {
				onRecoverableError: (error) => errors.push(String(error)),
			});
		});
		expect(errors).toEqual([]);
		container.remove();
	});
});
