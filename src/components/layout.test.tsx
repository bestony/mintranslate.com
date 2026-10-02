/**
 * Form-field accessibility and toolbar layout.
 *
 * Two reported defects, both checked the way they were observed:
 *
 * 1. Chrome DevTools reported "A form field element should have an id or name
 *    attribute". Every control the workspace renders must carry one, or it is
 *    unreachable by label and invisible to autofill.
 * 2. A large empty band appeared between the toolbar and the language rows. The
 *    output-actions block is a grid item, and a grid item stretches to its row by
 *    default; the row is as tall as the source column, so the block reserved
 *    hundreds of pixels for content it did not have.
 *
 * The layout check asserts the class that causes the stretch is absent, because a
 * real layout measurement needs a browser with a layout engine.
 *
 * @vitest-environment jsdom
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TranslationWorkspace } from "#/components/translation/TranslationWorkspace";

describe("form fields are labelled", () => {
	it("every control in the workspace has an id or a name", () => {
		const html = renderToString(<TranslationWorkspace />);

		const controls = html.match(/<(?:input|textarea|select)\b[^>]*>/g) ?? [];
		expect(controls.length).toBeGreaterThan(0);

		const unlabelled = controls.filter(
			(control) => !control.includes("id=") && !control.includes("name="),
		);
		expect(unlabelled).toEqual([]);
	});

	it("the translation textarea is named and labelled", () => {
		const html = renderToString(<TranslationWorkspace />);

		// The specific field DevTools flagged: no id, no name, no label.
		expect(html).toMatch(/<textarea[^>]*id="translation-source"/);
		expect(html).toMatch(/<textarea[^>]*name="source-text"/);
		expect(html).toMatch(/<textarea[^>]*aria-label=/);
	});
});

describe("toolbar layout", () => {
	it("the output-actions block does not stretch to the grid row height", () => {
		const html = renderToString(<TranslationWorkspace />);

		// `self-start` is what prevents the several-hundred-pixel empty band between
		// the toolbar and the language rows when there is no output yet.
		expect(html).toContain("flex flex-col gap-2 self-start");
	});

	it("the speech row and the source column are separate grid areas", () => {
		const html = renderToString(<TranslationWorkspace />);

		// The actions block must be its own grid child, not nested inside the source
		// column — nesting it would make the empty band part of the column instead.
		const actionsIndex = html.indexOf("flex flex-col gap-2 self-start");
		const sourceSectionIndex = html.indexOf("<section");
		expect(actionsIndex).toBeGreaterThan(-1);
		expect(actionsIndex).toBeLessThan(sourceSectionIndex);
	});
});
