import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createModelListController,
	loadModels,
	MODEL_LIST_FORMAT_ERROR,
	type ModelListResponse,
	type ModelListTransportFunction,
	modalitiesFromResponse,
	modelsUrlFor,
	parseModelList,
} from "./model-list";

afterEach(() => {
	vi.useRealTimers();
});

function response(payload: unknown, status = 200): ModelListResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => payload,
	};
}

describe("modelsUrlFor", () => {
	it.each([
		["https://host/v1", "https://host/v1/models"],
		["https://host/v1/", "https://host/v1/models"],
		["https://host", "https://host/models"],
		["https://host/", "https://host/models"],
		["https://host////", "https://host/models"],
	])("appends /models without a duplicate slash: %s", (endpoint, expected) => {
		expect(modelsUrlFor(endpoint)).toBe(expected);
	});

	it.each([
		"",
		"   ",
		"not a URL",
		"/relative/path",
		"https://",
	])("returns undefined for an empty or invalid endpoint: %s", (endpoint) => {
		expect(modelsUrlFor(endpoint)).toBeUndefined();
	});
});

describe("parseModelList", () => {
	it("parses the standard data shape", () => {
		expect(
			parseModelList({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
		).toEqual({ ok: true, models: ["gpt-4o", "gpt-4o-mini"] });
	});

	it("accepts the known models shape and string identifiers", () => {
		expect(
			parseModelList({ models: [{ name: "local-model" }, "another-model"] }),
		).toEqual({ ok: true, models: ["local-model", "another-model"] });
	});

	it("accepts an empty recognized list", () => {
		expect(parseModelList({ data: [] })).toEqual({ ok: true, models: [] });
	});

	it("ignores entries without a usable identifier and removes duplicates", () => {
		expect(
			parseModelList({
				data: [
					{ object: "model" },
					{ id: "  " },
					{ id: "good" },
					{ id: "good" },
				],
			}),
		).toEqual({ ok: true, models: ["good"] });
	});

	it.each([
		null,
		42,
		"models",
		[],
		{ data: {} },
		{ unknown: [] },
	])("reports an unrecognized response shape: %j", (payload) => {
		expect(parseModelList(payload)).toEqual({
			ok: false,
			reason: MODEL_LIST_FORMAT_ERROR,
		});
	});
});

describe("modalitiesFromResponse", () => {
	it("returns true when a response explicitly includes image input", () => {
		expect(
			modalitiesFromResponse({
				data: [
					{
						id: "gpt-4o",
						architecture: { input_modalities: ["text", "image"] },
					},
				],
			}),
		).toBe(true);
	});

	it("returns false when explicit modalities exclude image input", () => {
		expect(
			modalitiesFromResponse({
				data: [{ id: "text-model", input_modalities: ["text"] }],
			}),
		).toBe(false);
	});

	it("returns undefined when the endpoint supplies no modality field", () => {
		expect(
			modalitiesFromResponse({ data: [{ id: "vision-model" }] }),
		).toBeUndefined();
	});

	it("never infers capability from a model name", () => {
		expect(
			modalitiesFromResponse({ data: [{ id: "vision-4o-image" }] }),
		).toBeUndefined();
	});

	it("handles explicit string and boolean gateway fields", () => {
		expect(modalitiesFromResponse({ modality: "text+image->text" })).toBe(true);
		expect(modalitiesFromResponse({ supports_vision: false })).toBe(false);
	});
});

describe("loadModels", () => {
	it("requests the derived URL with the OpenAI authorization header", async () => {
		const transport = vi
			.fn<ModelListTransportFunction>()
			.mockResolvedValue(response({ data: [{ id: "remote-model" }] }));

		const result = await loadModels(
			{ endpoint: "https://host/v1/", apiKey: "secret-key" },
			transport,
		);

		expect(result).toEqual({ ok: true, models: ["remote-model"] });
		expect(transport).toHaveBeenCalledWith(
			"https://host/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: "Bearer secret-key",
				},
			}),
		);
		expect(JSON.stringify(result)).not.toContain("secret-key");
	});

	it("returns an attributed response failure", async () => {
		const transport = vi
			.fn<ModelListTransportFunction>()
			.mockResolvedValue(response({ error: "bad key" }, 401));

		const result = await loadModels(
			{ endpoint: "https://host/v1", apiKey: "secret-key" },
			transport,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.attribution.type).toBe("auth_401");
			expect(JSON.stringify(result)).not.toContain("secret-key");
		}
	});

	it("attributes an opaque transport rejection as CORS or network", async () => {
		const transport = vi
			.fn<ModelListTransportFunction>()
			.mockRejectedValue(new TypeError("Failed to fetch"));

		const result = await loadModels(
			{ endpoint: "https://host/v1", apiKey: "secret-key" },
			transport,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.attribution.type).toBe("cors_or_network");
			expect(result.attribution.checklist?.join(" ")).toContain("Endpoint");
		}
	});

	it("reports malformed successful bodies as bad_response", async () => {
		const transport = vi
			.fn<ModelListTransportFunction>()
			.mockResolvedValue(response({ unexpected: true }));

		const result = await loadModels(
			{ endpoint: "https://host/v1", apiKey: "secret-key" },
			transport,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.attribution.type).toBe("bad_response");
	});

	it("does not call the transport while offline", async () => {
		const transport = vi.fn<ModelListTransportFunction>();
		const result = await loadModels(
			{ endpoint: "https://host/v1", apiKey: "secret-key", online: false },
			transport,
		);

		expect(transport).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: false, reason: "offline" });
		if (!result.ok) expect(result.attribution.summary).toContain("离线");
	});
});

describe("createModelListController", () => {
	it("debounces a burst and keeps only the final request", async () => {
		vi.useFakeTimers();
		const transport = vi
			.fn<ModelListTransportFunction>()
			.mockResolvedValue(response({ data: [{ id: "last" }] }));
		const controller = createModelListController({
			transport,
			debounceMs: 500,
			isOnline: () => true,
		});

		const first = controller.request({
			endpoint: "https://one/v1",
			apiKey: "k",
		});
		const second = controller.request({
			endpoint: "https://two/v1",
			apiKey: "k",
		});

		await expect(first).resolves.toEqual({ kind: "superseded" });
		expect(transport).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(500);
		await expect(second).resolves.toMatchObject({
			kind: "result",
			value: { ok: true, models: ["last"] },
		});
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[0]).toBe("https://two/v1/models");
	});

	it("discards an older in-flight result when a newer request wins", async () => {
		vi.useFakeTimers();
		let resolveFirst!: (value: ModelListResponse) => void;
		let resolveSecond!: (value: ModelListResponse) => void;
		const firstResponse = new Promise<ModelListResponse>((resolve) => {
			resolveFirst = resolve;
		});
		const secondResponse = new Promise<ModelListResponse>((resolve) => {
			resolveSecond = resolve;
		});
		const transport = vi
			.fn<ModelListTransportFunction>()
			.mockReturnValueOnce(firstResponse)
			.mockReturnValueOnce(secondResponse);
		const controller = createModelListController({
			transport,
			debounceMs: 10,
			isOnline: () => true,
		});

		const first = controller.request({
			endpoint: "https://one/v1",
			apiKey: "k",
		});
		await vi.advanceTimersByTimeAsync(10);
		const second = controller.request({
			endpoint: "https://two/v1",
			apiKey: "k",
		});
		await vi.advanceTimersByTimeAsync(10);
		resolveSecond(response({ data: [{ id: "new" }] }));
		await expect(second).resolves.toMatchObject({
			kind: "result",
			value: { ok: true, models: ["new"] },
		});

		resolveFirst(response({ data: [{ id: "old" }] }));
		await expect(first).resolves.toEqual({ kind: "superseded" });
	});

	it("returns an offline explanation without scheduling a request", async () => {
		vi.useFakeTimers();
		const transport = vi.fn<ModelListTransportFunction>();
		const controller = createModelListController({
			transport,
			isOnline: () => false,
		});

		const outcome = await controller.request({
			endpoint: "https://host/v1",
			apiKey: "k",
		});

		expect(outcome.kind).toBe("result");
		if (outcome.kind === "result") {
			expect(outcome.value).toMatchObject({ ok: false, reason: "offline" });
		}
		expect(transport).not.toHaveBeenCalled();
		expect(controller.pending()).toBe(false);
	});
});
