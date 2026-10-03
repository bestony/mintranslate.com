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

import { act } from "react";
import { createRoot } from "react-dom/client";
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
import {
	capabilitiesAfterModelDiscovery,
	mergeModelCandidates,
} from "#/components/settings/ModelDiscoveryField";
import type { ModelListController } from "#/lib/connections/model-list";
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

function modelListController(
	value: Extract<
		Awaited<ReturnType<ModelListController["request"]>>,
		{ kind: "result" }
	>,
): ModelListController {
	return {
		request: vi.fn().mockResolvedValue(value),
		cancel: vi.fn(),
		pending: () => false,
	};
}

async function renderInteractive(
	overrides: Record<string, unknown>,
	controller: ModelListController,
) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const onChange = vi.fn();
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<ConnectionForm
				connection={connection(overrides) as never}
				apiKey="test-key"
				onChange={onChange}
				onProviderChange={() => {}}
				onKeyChange={() => {}}
				onTested={() => {}}
				testController={createConnectionTestController()}
				modelListController={controller}
			/>,
		);
	});
	return { container, onChange, root };
}

describe("intranet guidance in the form", () => {
	it("distinguishes the built-in text and multimodal channels", () => {
		const textHtml = render({
			id: "builtin-translator",
			name: "内置翻译（仅文本）",
			provider: "builtin-translator",
			endpoint: "",
			model: "",
			status: "ok",
		});
		const multimodalHtml = render({
			id: "builtin-multimodal",
			name: "内置多模态（文本与图片）",
			provider: "builtin-multimodal",
			endpoint: "",
			model: "",
			status: "ok",
		});

		expect(textHtml).toContain("仅支持文本");
		expect(textHtml).toContain("浏览器支持");
		expect(textHtml).toContain("不应用术语表与翻译风格");
		expect(textHtml).not.toContain('id="connection-endpoint"');
		expect(textHtml).not.toContain("测试连接");
		expect(multimodalHtml).toContain("支持文本与图片");
		expect(multimodalHtml).toContain("可应用术语表与翻译风格");
		expect(multimodalHtml).toContain("Prompt API 仅支持英语");
		expect(multimodalHtml).not.toContain('id="connection-api-key"');
	});

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

describe("model discovery in the form", () => {
	it.each([
		"openai",
		"deepseek",
		"openrouter",
		"custom",
	] as const)("shows the load entry for %s", (provider) => {
		expect(
			render({ provider, endpoint: "https://model.example/v1" }),
		).toContain("加载模型");
	});

	it.each([
		"anthropic",
		"gemini",
		"ollama",
	] as const)("does not show the entry for %s", (provider) => {
		expect(render({ provider })).not.toContain("加载模型");
	});

	it("merges static and loaded candidates without duplicates", () => {
		expect(
			mergeModelCandidates(["preset", "shared"], ["remote", "shared"]),
		).toEqual(["preset", "shared", "remote"]);
	});

	it("keeps a manual model and manual modality when endpoint modality is unknown", async () => {
		const controller = modelListController({
			kind: "result",
			value: { ok: true, models: ["remote-model"] },
		});
		const { container, onChange, root } = await renderInteractive(
			{
				model: "handwritten-model",
				capabilities: { text: true, vision: true },
			},
			controller,
		);

		await act(async () => {
			(container.querySelector("#load-models-c1") as HTMLButtonElement).click();
		});

		const modelInput = container.querySelector(
			"#connection-model",
		) as HTMLInputElement;
		const options = Array.from(
			container.querySelectorAll(`#models-c1 option`),
		).map((option) => option.getAttribute("value"));
		expect(modelInput.value).toBe("handwritten-model");
		expect(options).toContain("remote-model");
		expect(onChange).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("applies endpoint-provided vision without changing the selected model", async () => {
		const controller = modelListController({
			kind: "result",
			value: { ok: true, models: ["remote-model"], vision: true },
		});
		const { container, onChange, root } = await renderInteractive(
			{ model: "handwritten-model" },
			controller,
		);

		await act(async () => {
			(container.querySelector("#load-models-c1") as HTMLButtonElement).click();
		});

		expect(onChange).toHaveBeenCalledWith({
			capabilities: { text: true, vision: true },
		});
		expect(container.textContent).toContain("视觉能力来自端点");
		await act(async () => root.unmount());
	});

	it("keeps capabilities unchanged for an unknown modality", () => {
		const capabilities = { text: true, vision: true } as const;
		expect(capabilitiesAfterModelDiscovery(capabilities, undefined)).toBe(
			capabilities,
		);
		expect(capabilitiesAfterModelDiscovery(capabilities, false)).toEqual({
			text: true,
			vision: false,
		});
	});
});
