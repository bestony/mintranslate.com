import { describe, expect, it } from "vitest";

import {
	MODEL_LIST_FORMAT_ERROR,
	modalitiesFromResponse,
	modelsUrlFor,
	parseModelList,
} from "./model-list";

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
