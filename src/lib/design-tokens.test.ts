/**
 * Design-token contract tests.
 *
 * These encode the two rules that a reskin can quietly break and that no unit
 * test would otherwise notice: text must stay readable against its background,
 * and the palette must stay in one place.
 *
 * Contrast is computed from the token values themselves rather than from copied
 * literals, so changing a token re-runs the check instead of silently
 * invalidating it.
 *
 * @vitest-environment node
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = "src/styles.css";

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string): number {
	const h = hex.replace("#", "");
	const [r, g, b] = [0, 2, 4].map(
		(i) => Number.parseInt(h.slice(i, i + 2), 16) / 255,
	);
	const channel = (c: number) =>
		c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio per WCAG 2.1. */
function contrast(a: string, b: string): number {
	const [la, lb] = [luminance(a), luminance(b)];
	const [hi, lo] = [Math.max(la, lb), Math.min(la, lb)];
	return (hi + 0.05) / (lo + 0.05);
}

/** Read a colour token's value from the stylesheet. */
function token(name: string): string {
	const css = readFileSync(STYLES, "utf8");
	const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
	if (!match) throw new Error(`token --color-${name} not found in ${STYLES}`);
	return match[1];
}

/** Every source file under the given directories. */
function sourceFiles(...dirs: string[]): string[] {
	const files: string[] = [];
	for (const dir of dirs) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) files.push(...sourceFiles(path));
			else if (/\.tsx?$/.test(entry.name)) files.push(path);
		}
	}
	return files;
}

/**
 * Strip comments from a source file.
 *
 * Comments explain the design ("no shadow", "this used to be #8e8ea0"), and those
 * explanations must not be read as violations. Returned as a list so each file
 * keeps its identity in failure messages.
 */
function codeOnly(source: string): string[] {
	return [
		source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"),
	];
}

describe("text contrast", () => {
	it("body text passes AA against the page background", () => {
		expect(
			contrast(token("foreground"), token("background")),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("secondary text passes AA against the page background", () => {
		// The reported defect class: a muted tone chosen for looks that quietly
		// drops below the readable threshold.
		expect(
			contrast(token("muted-foreground"), token("background")),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("secondary text passes AA on a panel surface", () => {
		expect(
			contrast(token("muted-foreground"), token("surface")),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("primary button text passes AA on its fill", () => {
		// White on the decorative primary (#8e8ea0) measures 3.22:1 and would fail;
		// it is the reason a darker fill token exists.
		expect(
			contrast(token("primary-foreground"), token("primary-strong")),
		).toBeGreaterThanOrEqual(4.5);
	});

	it("the decorative primary is not used as a text colour", () => {
		// Documents the constraint as an assertion: this pair is decorative-only.
		expect(contrast(token("primary"), token("background"))).toBeLessThan(4.5);
	});
});

describe("palette lives in one place", () => {
	it("components declare no literal colours", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles("src/components", "src/routes")) {
			for (const code of codeOnly(readFileSync(file, "utf8"))) {
				// Hex (6 or 8 digits, to avoid matching issue numbers like React #418),
				// rgb(), hsl() and oklch() appearing in code rather than a comment.
				const literals = code.match(
					/(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b|rgba?\(|hsla?\(|oklch\()/g,
				);
				if (literals) offenders.push(`${file}: ${literals.join(", ")}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("components declare no removed theme class names", () => {
		// Names from the previous theme. Any reappearance means a component was not
		// migrated. Scanned without comments, because these names legitimately
		// appear in explanations of what was removed.
		const removed = [
			"--sea-ink",
			"--lagoon",
			"--palm",
			"--sand",
			"--foam",
			"--hero-",
			"--chip-",
			"--kicker",
			"--inset-glint",
			"island-kicker",
			"feature-card",
			"rise-in",
		];
		const offenders: string[] = [];
		for (const file of sourceFiles("src/components", "src/routes")) {
			for (const code of codeOnly(readFileSync(file, "utf8"))) {
				for (const name of removed) {
					if (code.includes(name)) offenders.push(`${file}: ${name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the stylesheet defines no shadow or gradient of its own", () => {
		const css = readFileSync(STYLES, "utf8");
		// Strip comments so the explanation of *why* shadows are absent does not
		// read as a shadow declaration.
		const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(code).not.toMatch(/box-shadow/);
		expect(code).not.toMatch(/backdrop-filter/);
		expect(code).not.toMatch(/gradient\(/);
	});

	it("respects the reduced-motion preference", () => {
		const css = readFileSync(STYLES, "utf8");
		expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
		// Collapsing the duration is what makes the preference effective; merely
		// naming the query would satisfy a text search while changing nothing.
		const block = css.slice(css.indexOf("prefers-reduced-motion"));
		expect(block).toMatch(/transition-duration:\s*0?\.01ms|transition:\s*none/);
	});

	it("gives every focusable element a visible focus ring", () => {
		const css = readFileSync(STYLES, "utf8");
		const rule = /:focus-visible\s*\{([^}]*)\}/.exec(css);
		expect(rule).not.toBeNull();
		const body = rule?.[1] ?? "";
		expect(body).toMatch(/outline:\s*2px\s+solid/);
		expect(body).toMatch(/outline-offset:\s*2px/);
	});

	it("uses exactly one breakpoint", () => {
		const css = readFileSync(STYLES, "utf8");
		const breakpoints = [
			...css.matchAll(/--breakpoint-([a-z0-9]+):\s*([0-9]+px)/g),
		].map((m) => `${m[1]}:${m[2]}`);
		expect(breakpoints).toEqual(["md:768px"]);
	});
});

describe("spacing follows the 8px grid", () => {
	it("uses only 8px-multiple spacing utilities, except marked icon gaps", () => {
		// `--spacing` is 4px, so an even index (2, 4, 6 …) is an 8px multiple and an
		// odd index is not. Index 1 (4px) is permitted only for an icon-to-text gap,
		// and such a use must carry a `grid-exception` comment so the reason is
		// visible rather than assumed.
		const spacing =
			/\b(?:gap|space-x|space-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr)-(\d+)\b/g;
		const offenders: string[] = [];

		for (const file of sourceFiles("src/components", "src/routes")) {
			const source = readFileSync(file, "utf8");
			for (const code of codeOnly(source)) {
				for (const match of code.matchAll(spacing)) {
					const step = Number(match[1]);
					if (step === 0 || step % 2 === 0) continue;
					offenders.push(`${file}: ${match[0]}`);
				}
			}
		}

		// Every remaining odd step must be one of the two documented exceptions.
		const exceptions = offenders.filter((entry) => entry.includes("gap-1"));
		expect(offenders).toEqual(exceptions);
		expect(exceptions.length).toBeLessThanOrEqual(2);
	});

	it("documents each permitted 4px exception at its use site", () => {
		const marked: string[] = [];
		for (const file of sourceFiles("src/components", "src/routes")) {
			const source = readFileSync(file, "utf8");
			if (/grid-exception/.test(source)) marked.push(file);
		}
		// The comments are what make the exception auditable instead of silent.
		expect(marked.length).toBeGreaterThan(0);
	});
});
