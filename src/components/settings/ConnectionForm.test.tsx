/**
 * Connection form: intranet guidance is visible before a test runs.
 *
 * The notice has to be present as soon as a self-hosted endpoint is typed, because
 * the failure it warns about arrives as an opaque `TypeError` that names no cause.
 * Asserted from the rendered markup, and from the fact that the component takes no
 * test-result input at all.
 *
 * @vitest-environment jsdom
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The form pulls in provider presets and analytics; neither is under test here.
vi.mock("#/lib/analytics/track", async () => {
	const actual = await vi.importActual<typeof import("#/lib/analytics/track")>(
		"#/lib/analytics/track",
	);
	return { ...actual, createAnalytics: () => ({ track: () => {} }) };
});

import { ConnectionForm } from "#/components/settings/ConnectionForm";
import { createConnectionTestController } from "#/lib/connections/test-controller";

/** Minimal connection, matching the store's shape. */
function connection(overrides: Record<string, unknown> = {}) {
	return {
		id: "c1",
		name: "内网模型",
		provider: "custom" as const,
		endpoint: "https://model.lan:8443/v1",
		model: "llama3.1",
		capabilities: { text: true, vision: false },
		status: "untested" as const,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** Render the form with the required callbacks stubbed. */
function render(overrides: Record<string, unknown> = {}) {
	return renderToString(
		<ConnectionForm
			connection={connection(overrides) as never}
			apiKey=""
			onChange={() => {}}
			onProviderChange={() => {}}
			onKeyChange={() => {}}
			onTested={() => {}}
			testController={createConnectionTestController()}
		/>,
	);
}

describe("intranet guidance in the form", () => {
	it("shows the conditions for a self-hosted endpoint", () => {
		const html = render();
		// The heading is what makes it visible this is pre-flight guidance rather
		// than a failure report.
		expect(html).toContain("内网自建模型的接入前提");
		expect(html).toContain("HTTPS");
		expect(html).toContain("Origin");
	});

	it("does not show it for a public provider endpoint", () => {
		const html = render({
			provider: "openai",
			endpoint: "https://api.openai.com/v1",
		});
		expect(html).not.toContain("内网自建模型的接入前提");
	});

	it("names the deployment-guide section for the framework examples", () => {
		const html = render();
		expect(html).toContain("部署文档");
		// Four frameworks are named so a deployer knows their case is covered.
		for (const framework of ["Ollama", "vLLM", "LM Studio", "Nginx"]) {
			expect(html).toContain(framework);
		}
	});
});
