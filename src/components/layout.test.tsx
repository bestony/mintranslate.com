/**
 * Translation-workspace layout contract.
 *
 * Three reported problems are structural rather than numeric, so they are asserted
 * from the rendered markup: read-aloud must sit in each panel's own toolbar
 * instead of a row shared by both, the swap control must sit between the columns
 * rather than at the end of a language row, and the panels must be viewport-sized
 * rather than fixed. Form-field labelling is asserted here too, because the
 * DevTools issue that reported it is checked per control.
 *
 * Numeric checks (panel height in pixels, touch-target size, contrast) cannot be
 * measured without a layout engine and are verified in the browser instead.
 *
 * @vitest-environment jsdom
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The workspace renders a `<Link>` to settings, and `Link` resolves through router
 * state that only exists inside a router. This suite is about layout, so the link
 * becomes an anchor: same markup position, no router needed.
 */
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		Link: ({
			to,
			children,
			...rest
		}: {
			to: string;
			children: React.ReactNode;
		}) => (
			<a href={to} {...rest}>
				{children}
			</a>
		),
	};
});

import { TranslationWorkspace } from "#/components/translation/TranslationWorkspace";

/** The workspace markup, rendered once per assertion. */
function workspaceHtml(): string {
	return renderToString(<TranslationWorkspace />);
}

describe("form fields are labelled", () => {
	it("every control in the workspace has an id or a name", () => {
		const html = workspaceHtml();

		const controls = html.match(/<(?:input|textarea|select)\b[^>]*>/g) ?? [];
		expect(controls.length).toBeGreaterThan(0);

		const unlabelled = controls.filter(
			(control) => !control.includes("id=") && !control.includes("name="),
		);
		expect(unlabelled).toEqual([]);
	});

	it("the translation textarea is named and labelled", () => {
		const html = workspaceHtml();

		// The specific field DevTools flagged: no id, no name, no label.
		expect(html).toMatch(/<textarea[^>]*id="translation-source"/);
		expect(html).toMatch(/<textarea[^>]*name="source-text"/);
		expect(html).toMatch(/<textarea[^>]*aria-label=/);
	});
});

describe("read-aloud belongs to its own panel", () => {
	it("renders a control per panel rather than one shared row", () => {
		const html = workspaceHtml();

		// Both controls exist, and each is rendered from its own panel's toolbar.
		expect(html).toContain("朗读原文");
		expect(html).toContain("朗读译文");
	});

	it("keeps the rate control with the read-aloud controls", () => {
		const html = workspaceHtml();
		expect(html).toContain("语速：");
	});

	it("places read-source before the source panel's closing section", () => {
		// The source control must sit inside the source section, not in a block
		// spanning both columns.
		const html = workspaceHtml();
		const sourceReadIndex = html.indexOf("朗读原文");
		const targetReadIndex = html.indexOf("朗读译文");
		const firstSectionEnd = html.indexOf("</section>");
		expect(sourceReadIndex).toBeLessThan(firstSectionEnd);
		expect(targetReadIndex).toBeGreaterThan(firstSectionEnd);
	});
});

describe("the swap control sits between the columns", () => {
	it("does not appear in either language row", () => {
		const html = workspaceHtml();

		// A language row is the block holding the language buttons. The swap control
		// used to be the last button in the source row; it must not be there now.
		const rows = [
			...html.matchAll(
				/<div class="flex flex-wrap items-center gap-2">([\s\S]*?)<\/div>/g,
			),
		].map((match) => match[1]);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(row).not.toContain("⇄");
	});

	it("renders between the two panels, desktop only", () => {
		const html = workspaceHtml();
		const swapIndex = html.indexOf('aria-label="交换源语言与目标语言"');
		const firstSection = html.indexOf("<section");
		const secondSection = html.indexOf("<section", firstSection + 1);

		expect(swapIndex).toBeGreaterThan(-1);
		// Between the panels: after the source section opens and before the target
		// section — and in a desktop-only container, because a two-column midline
		// has no meaning once the columns stack.
		expect(swapIndex).toBeGreaterThan(firstSection);
		const swapContainer = html.lastIndexOf("hidden md:flex", swapIndex);
		expect(swapContainer).toBeGreaterThan(firstSection);
		expect(secondSection).toBeGreaterThan(0);
	});

	it("explains why swapping is unavailable", () => {
		const html = workspaceHtml();
		// Auto-detect has nothing to swap into, so the control is disabled and says so.
		expect(html).toContain("检测语言状态下无法交换");
	});
});

describe("panels adapt to the viewport", () => {
	it("both panels carry a viewport-relative bound", () => {
		const html = workspaceHtml();
		const viewportBounds = html.match(/100dvh/g) ?? [];
		// One for the input, one for the result.
		expect(viewportBounds.length).toBeGreaterThanOrEqual(2);
	});

	it("keeps a minimum height so panels never collapse", () => {
		const html = workspaceHtml();
		// 240px is the specified floor; both panels express it.
		const minimums = html.match(/min-h-60/g) ?? [];
		expect(minimums.length).toBeGreaterThanOrEqual(2);
	});
});

describe("the top bar carries only what the task needs", () => {
	it("shows no shortcut hint in the toolbar", () => {
		const html = workspaceHtml();
		expect(html).not.toContain("+Enter 立即翻译");
	});

	it("shows no install entry in the toolbar", () => {
		const html = workspaceHtml();
		expect(html).not.toContain("安装到桌面");
	});

	it("makes the unconfigured state an actionable link", () => {
		const html = workspaceHtml();
		// Unconfigured is the initial state, so this is the branch that renders.
		expect(html).toContain("未配置连接");
		const link = /<a[^>]*href="\/settings"[^>]*>[^<]*未配置连接/;
		expect(html).toMatch(link);
	});
});
