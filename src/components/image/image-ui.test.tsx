/**
 * Image mode UI contracts.
 *
 * Rendered from markup rather than driven through a DOM, which is how the rest of
 * this repository tests components. What is asserted here is structure and
 * accessibility — the parts a reviewer would otherwise have to check by eye:
 * labelled controls, announced states, regions reachable by keyboard, and no
 * persistence of image data.
 *
 * @vitest-environment jsdom
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ImageDropZone } from "#/components/image/ImageDropZone";
import {
	ImageResultView,
	RESULT_VIEWS,
} from "#/components/image/ImageResultView";
import { RegionOverlay } from "#/components/image/RegionOverlay";
import type { ImageRegion } from "#/lib/image";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		// The anchor needs an href to be a valid link; these components never render
		// one, so the stub only has to be legal.
		Link: ({ children }: { children: React.ReactNode }) => (
			<a href="/">{children}</a>
		),
	};
});

const REGIONS: readonly ImageRegion[] = [
	{
		id: "r0",
		source: "Hello",
		target: "你好",
		box: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
		uncertain: false,
	},
	{
		id: "r1",
		source: "World",
		target: "世界",
		uncertain: true,
	},
];

describe("drop zone", () => {
	it("offers a labelled file input", () => {
		const html = renderToString(
			<ImageDropZone onAccept={() => {}} onReject={() => {}} />,
		);
		// DevTools reported unlabelled fields before; this asserts the new control
		// carries an id and a name.
		expect(html).toMatch(/<input[^>]*id="image-file-input"/);
		expect(html).toMatch(/<input[^>]*name="image-file"/);
	});

	it("states the accepted formats and limit", () => {
		const html = renderToString(
			<ImageDropZone onAccept={() => {}} onReject={() => {}} />,
		);
		expect(html).toContain("webp");
		expect(html).toContain("10.0 MB");
	});

	it("mentions pasting as an entry", () => {
		const html = renderToString(
			<ImageDropZone onAccept={() => {}} onReject={() => {}} />,
		);
		expect(html).toContain("粘贴");
	});

	it("has a visible instruction in the resting state", () => {
		const html = renderToString(
			<ImageDropZone onAccept={() => {}} onReject={() => {}} />,
		);
		expect(html).toContain("把图片拖到这里");
	});

	it("disables the picker while a run is in flight", () => {
		const html = renderToString(
			<ImageDropZone onAccept={() => {}} onReject={() => {}} disabled />,
		);
		expect(html).toMatch(/<input[^>]*disabled/);
	});
});

describe("result view modes", () => {
	it("renders all three views", () => {
		const html = renderToString(
			<ImageResultView regions={REGIONS} imageSrc="blob:x" imageAlt="图" />,
		);
		for (const label of ["原文", "译文", "对照"]) {
			expect(html).toContain(label);
		}
	});

	it("marks the current view for assistive technology", () => {
		const html = renderToString(
			<ImageResultView regions={REGIONS} imageSrc="blob:x" imageAlt="图" />,
		);
		// `aria-pressed` on the active view, plus a text statement of which it is.
		expect(html).toMatch(/aria-pressed="true"/);
		expect(html).toContain("当前视图：");
	});

	it("labels the view switch group", () => {
		const html = renderToString(
			<ImageResultView regions={REGIONS} imageSrc="blob:x" imageAlt="图" />,
		);
		expect(html).toMatch(
			/role="toolbar"[^>]*aria-label="结果视图"|aria-label="结果视图"/,
		);
	});

	it("exposes exactly three views", () => {
		expect(RESULT_VIEWS).toHaveLength(3);
	});
});

describe("region list", () => {
	it("keeps every region, including one with no position", () => {
		const html = renderToString(
			<ImageResultView regions={REGIONS} imageSrc="blob:x" imageAlt="图" />,
		);
		// Both texts appear: a region without a box is still listed.
		expect(html).toContain("Hello");
		expect(html).toContain("World");
		expect(html).toContain("未定位");
	});

	it("lists regions in a navigable structure", () => {
		const html = renderToString(
			<ImageResultView regions={REGIONS} imageSrc="blob:x" imageAlt="图" />,
		);
		expect(html).toMatch(/<ol[^>]*aria-label="识别到的文字区域"/);
	});

	it("uses real buttons so the keyboard can reach each region", () => {
		const html = renderToString(
			<ImageResultView regions={REGIONS} imageSrc="blob:x" imageAlt="图" />,
		);
		// Scoped to the list: the overlay carries the same attribute on its own
		// elements, and both are supposed to be focusable.
		const list = html.slice(html.indexOf("<ol"), html.indexOf("</ol>"));
		const buttons = list.match(/<button[^>]*data-region-id/g) ?? [];
		expect(buttons).toHaveLength(2);
	});
});

describe("uncertainty is stated, not just tinted", () => {
	it("marks uncertain regions in text", () => {
		const html = renderToString(
			<ImageResultView regions={REGIONS} imageSrc="blob:x" imageAlt="图" />,
		);
		expect(html).toContain("识别不确定");
	});

	it("marks them differently in the overlay", () => {
		const locatableUncertain: readonly ImageRegion[] = [
			{
				id: "u1",
				source: "blurry",
				target: "模糊",
				box: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 },
				uncertain: true,
			},
		];
		const html = renderToString(
			<RegionOverlay
				regions={locatableUncertain}
				onActivate={() => {}}
				imageAlt="图"
				imageSrc="blob:x"
			/>,
		);
		// A dashed edge distinguishes uncertain from determined without relying on
		// colour, and the label names it for a screen reader.
		expect(html).toMatch(/data-uncertain="true"[^>]*|border-dashed/);
		expect(html).toContain("border-dashed");
		expect(html).toContain("识别不确定");
	});

	it("does not mark certain regions as uncertain", () => {
		const html = renderToString(
			<RenderableOnly regions={[{ ...REGIONS[0] }]} />,
		);
		expect(html).not.toContain("识别不确定");
		expect(html).not.toContain("border-dashed");
	});
});

/** Renders just the overlay for a region set. */
function RenderableOnly({
	regions,
}: {
	readonly regions: readonly ImageRegion[];
}) {
	return (
		<RegionOverlay
			regions={regions}
			onActivate={() => {}}
			imageAlt="图"
			imageSrc="blob:x"
		/>
	);
}

describe("overlay geometry", () => {
	it("positions regions with percentages, not pixels", () => {
		const html = renderToString(<RenderableOnly regions={REGIONS} />);
		// Percentages let the overlay track the image at any display size without
		// measuring anything.
		expect(html).toContain("left:10%");
		expect(html).toContain("width:30%");
	});

	it("gives the image a meaningful alt text", () => {
		const html = renderToString(<RenderableOnly regions={REGIONS} />);
		expect(html).toMatch(/<img[^>]*alt="图"/);
	});

	it("omits the overlay element for a region without a box", () => {
		const html = renderToString(<RenderableOnly regions={[REGIONS[1]]} />);
		expect(html).not.toContain("data-region-id");
	});

	it("draws no shadow, keeping the design flat", () => {
		const html = renderToString(<RenderableOnly regions={REGIONS} />);
		expect(html).not.toContain("shadow");
	});
});

describe("degraded and empty results", () => {
	it("explains a parse failure and shows the raw text", () => {
		const html = renderToString(
			<ImageResultView
				regions={[]}
				imageSrc="blob:x"
				imageAlt="图"
				rawText="Some prose the model returned"
			/>,
		);
		expect(html).toContain("无法按结构解析");
		expect(html).toContain("Some prose the model returned");
	});

	it("says no text was found rather than showing a bare result", () => {
		const html = renderToString(
			<ImageResultView regions={[]} imageSrc="blob:x" imageAlt="图" />,
		);
		expect(html).toContain("未在图片中识别到文字");
	});
});

describe("no storage of image data", () => {
	it("does not import a persistence module", async () => {
		const { readFileSync } = await import("node:fs");
		for (const file of [
			"src/components/image/ImageTranslationMode.tsx",
			"src/components/image/ImageDropZone.tsx",
			"src/components/image/ImageResultView.tsx",
			"src/components/image/RegionOverlay.tsx",
		]) {
			const source = readFileSync(file, "utf8");
			expect(source, file).not.toMatch(
				/from "#\/lib\/(history|translation-memory)/,
			);
		}
	});
});
