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
		// Two controls exist, one per layout. Locate the desktop one by its
		// desktop-only container rather than by a bare index, which would otherwise
		// find the mobile control (it appears first in the markup).
		const desktopMarker = html.indexOf("hidden md:flex");
		expect(desktopMarker).toBeGreaterThan(-1);

		const desktopSwap = html.indexOf(
			'aria-label="交换源语言与目标语言"',
			desktopMarker,
		);
		expect(desktopSwap).toBeGreaterThan(desktopMarker);

		// The desktop control sits after the desktop-only container opens, which is
		// between the source panel and the target panel — the columns' midline.
		const secondSection = html.indexOf(
			"<section",
			html.indexOf("<section") + 1,
		);
		expect(secondSection).toBeGreaterThan(desktopMarker);
	});

	it("explains why swapping is unavailable", () => {
		const html = workspaceHtml();
		// Auto-detect has nothing to swap into, so the control is disabled and says so.
		expect(html).toContain("检测语言状态下无法交换");
	});
});

describe("panels adapt to the viewport", () => {
	it("fills the height left over after the surrounding chrome", () => {
		const html = workspaceHtml();
		// The panels grow into the space `main` hands them instead of being capped at
		// a fixed height. `flex-1` on both panels is what makes them fill the viewport
		// without a magic offset constant that drifts when chrome changes size.
		const flexFills =
			html.match(/min-h-60[^"]*flex-1|flex-1[^"]*min-h-60/g) ?? [];
		expect(flexFills.length).toBeGreaterThanOrEqual(2);
	});

	it("lets the workspace shrink rather than overflow", () => {
		const html = workspaceHtml();
		// Without `min-h-0` a flex child refuses to shrink below its content, so the
		// panels would push the page taller instead of fitting the viewport.
		expect(html).toContain("min-h-0");
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

describe("the swap control exists at both breakpoints", () => {
	it("renders a swap control for the stacked layout", () => {
		// The desktop axis is `hidden md:flex`, so with no mobile counterpart the
		// language pair could not be swapped at all below the breakpoint.
		const html = workspaceHtml();
		const swapControls = html.match(/aria-label="交换源语言与目标语言"/g) ?? [];
		expect(swapControls.length).toBe(2);
	});

	it("gives the mobile control a vertical arrow and a centred position", () => {
		const html = workspaceHtml();
		// Vertical, because the panels stack; centred, so it reads as sitting between
		// the source panel and the target row.
		expect(html).toContain("⇅");
		expect(html).toMatch(/flex justify-center md:hidden/);
	});

	it("gives both swap controls a 44px touch target", () => {
		const html = workspaceHtml();
		// Every swap control carries the minimum target class.
		const controls = html.split('aria-label="交换源语言与目标语言"');
		expect(controls.length - 1).toBe(2);
		for (const before of controls.slice(0, 2)) {
			const classes = before.slice(before.lastIndexOf('class="'));
			expect(classes).toContain("min-h-11");
		}
	});
});

describe("the selected language is distinguishable", () => {
	it("marks the active language with aria-current", () => {
		const html = workspaceHtml();
		// Auto-detect is the default source, and the target default is selected too.
		const currents = html.match(/aria-current="true"/g) ?? [];
		expect(currents.length).toBeGreaterThanOrEqual(2);
	});

	it("fills the selected chip with the action colour", () => {
		const html = workspaceHtml();
		// A tint was indistinguishable from an unselected chip; the selected state
		// now uses the same filled pair as a primary button.
		const selected =
			html.match(/bg-primary-strong text-primary-foreground/g) ?? [];
		expect(selected.length).toBeGreaterThanOrEqual(2);
	});

	it("does not use the decorative primary as a chip fill", () => {
		const html = workspaceHtml();
		// `bg-primary/10` was the ambiguous treatment this replaces.
		expect(html).not.toContain("bg-primary/10");
	});
});

describe("language rows stay on one line at 390px", () => {
	it("hides entries beyond the mobile count below the breakpoint", () => {
		const html = workspaceHtml();
		// Two quick entries plus the selected chip and "more" fit one row at 390px.
		const mobileHidden = html.match(/hidden md:inline-flex/g) ?? [];
		expect(mobileHidden.length).toBeGreaterThanOrEqual(2);
	});

	it("keeps every entry reachable through the more control", () => {
		const html = workspaceHtml();
		// Hiding an entry must not remove it: the picker still lists all languages.
		expect(html).toContain("更多");
		// Both sides offer it.
		expect((html.match(/更多/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("prevents chips from shrinking or wrapping inside a row", () => {
		const html = workspaceHtml();
		// `shrink-0` stops a chip from being squeezed into a second line.
		expect(html).toContain("shrink-0");
	});
});
