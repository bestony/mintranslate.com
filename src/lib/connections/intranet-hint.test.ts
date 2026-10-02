/**
 * Intranet guidance decision table.
 *
 * The notice explains conditions the model side must satisfy. It must appear for
 * self-hosted endpoints and stay off public providers — including `ollama`, which
 * is a built-in preset *and* self-hosted, which is the case the naive
 * "is it a preset" test gets wrong.
 *
 * @vitest-environment node
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { intranetHint, needsIntranetConditions } from "./intranet-hint";

const PAGE = "https://app.internal/";

describe("needsIntranetConditions", () => {
	it("shows for a custom endpoint on another origin", () => {
		expect(
			needsIntranetConditions({
				provider: "custom",
				endpoint: "https://model.lan:8443/v1",
				pageUrl: PAGE,
			}),
		).toBe(true);
	});

	it("shows for ollama, which is self-hosted even though it is a preset", () => {
		// The case a "is it a built-in preset" test would suppress, losing the
		// guidance exactly where an intranet user needs it.
		expect(
			needsIntranetConditions({
				provider: "ollama",
				endpoint: "http://localhost:11434",
				pageUrl: PAGE,
			}),
		).toBe(true);
	});

	it("stays off every public provider preset", () => {
		// Every one of these is cross-origin from the application, so an origin
		// comparison alone would put the notice on all of them.
		const publicProviders = [
			{ provider: "openai" as const, endpoint: "https://api.openai.com/v1" },
			{
				provider: "anthropic" as const,
				endpoint: "https://api.anthropic.com",
			},
			{
				provider: "gemini" as const,
				endpoint: "https://generativelanguage.googleapis.com",
			},
			{
				provider: "deepseek" as const,
				endpoint: "https://api.deepseek.com/v1",
			},
			{
				provider: "openrouter" as const,
				endpoint: "https://openrouter.ai/api/v1",
			},
		];

		for (const { provider, endpoint } of publicProviders) {
			expect(
				needsIntranetConditions({ provider, endpoint, pageUrl: PAGE }),
				`${provider} must not show the intranet notice`,
			).toBe(false);
		}
	});

	it("stays off a same-origin endpoint", () => {
		// Same origin needs neither HTTPS nor an origin allowlist entry.
		expect(
			needsIntranetConditions({
				provider: "custom",
				endpoint: "https://app.internal/v1",
				pageUrl: PAGE,
			}),
		).toBe(false);
	});

	it("treats a differing port as cross-origin", () => {
		// Same host, different port is genuinely a different origin, so the
		// conditions do apply.
		expect(
			needsIntranetConditions({
				provider: "custom",
				endpoint: "https://app.internal:8443/v1",
				pageUrl: PAGE,
			}),
		).toBe(true);
	});

	it("stays quiet for an empty or half-typed endpoint", () => {
		// Otherwise the notice flickers on every keystroke while typing a URL.
		for (const endpoint of ["", "   ", "http://", "not a url", "//host"]) {
			expect(
				needsIntranetConditions({
					provider: "custom",
					endpoint,
					pageUrl: PAGE,
				}),
				`endpoint ${JSON.stringify(endpoint)} must not show the notice`,
			).toBe(false);
		}
	});

	it("shows for a self-hosted endpoint when the page origin is unknown", () => {
		// Prerender and tests have no origin; erring towards telling the user the
		// conditions is better than silently omitting them.
		expect(
			needsIntranetConditions({
				provider: "custom",
				endpoint: "https://model.lan/v1",
				pageUrl: undefined,
			}),
		).toBe(true);
	});

	it("matches on host, so a public host on another path is still public", () => {
		expect(
			needsIntranetConditions({
				provider: "custom",
				endpoint: "https://api.openai.com/v1/other/path",
				pageUrl: PAGE,
			}),
		).toBe(false);
	});
});

describe("intranetHint", () => {
	it("states both conditions and that neither alone suffices", () => {
		const hint = intranetHint({
			provider: "custom",
			endpoint: "https://model.lan/v1",
			pageUrl: PAGE,
		});

		const text = hint.conditions.join(" ");
		expect(text).toContain("HTTPS");
		expect(text).toContain("Origin");
		expect(text).toContain("缺一不可");
	});

	it("does not depend on any test result", () => {
		// The notice must be visible before a test is run, so nothing about the
		// connection's status can influence it. Asserted by construction: the input
		// carries no status field at all.
		const hint = intranetHint({
			provider: "custom",
			endpoint: "https://model.lan/v1",
			pageUrl: PAGE,
		});
		expect(hint.show).toBe(true);
		expect(Object.keys(hint)).toEqual(["show", "conditions", "docsSection"]);
	});

	it("names a section that actually exists in the deployment guide", () => {
		// A section name that does not exist would send a deployer looking for
		// something that is not there, so the two are checked against each other
		// rather than asserted to look plausible.
		const guide = readFileSync("docs/deployment.md", "utf8");
		const hint = intranetHint({
			provider: "custom",
			endpoint: "https://model.lan/v1",
			pageUrl: PAGE,
		});

		expect(hint.docsSection.length).toBeGreaterThan(0);
		expect(guide).toContain(hint.docsSection);
	});

	it("hides the conditions when show is false", () => {
		const hint = intranetHint({
			provider: "openai",
			endpoint: "https://api.openai.com/v1",
			pageUrl: PAGE,
		});
		expect(hint.show).toBe(false);
	});
});
