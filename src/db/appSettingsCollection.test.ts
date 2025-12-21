import { describe, expect, it } from "vitest";

import {
	APP_SETTINGS_ID,
	APP_SETTINGS_STORAGE_KEY,
	appSettingsCollection,
	appSettingsSchema,
} from "@/db/appSettingsCollection";

describe("appSettingsCollection", () => {
	it("exports stable constants", () => {
		expect(APP_SETTINGS_STORAGE_KEY).toBe("mintranslate.appSettings");
		expect(APP_SETTINGS_ID).toBe("app");
	});

	it("validates settings shape", () => {
		const parsed = appSettingsSchema.parse({
			id: "app",
			systemPrompt: "hello",
			updatedAt: 123,
		});
		expect(parsed.systemPrompt).toBe("hello");
	});

	it("rejects invalid settings", () => {
		expect(() =>
			appSettingsSchema.parse({
				id: "app",
				systemPrompt: 123, // wrong type
				updatedAt: 123,
			}),
		).toThrow();
	});

	it("validates using safeParse", () => {
		const valid = appSettingsSchema.safeParse({
			id: "app",
			systemPrompt: "test",
			updatedAt: 456,
		});
		expect(valid.success).toBe(true);

		const invalid = appSettingsSchema.safeParse({
			id: "app",
			systemPrompt: 123,
			updatedAt: 456,
		});
		expect(invalid.success).toBe(false);
	});

	it("derives collection keys from item id", () => {
		const key = appSettingsCollection.getKeyFromItem({
			id: "app",
			systemPrompt: "hello",
			updatedAt: 123,
		});
		expect(key).toBe("app");
	});
});
