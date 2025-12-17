import {
	createCollection,
	localStorageCollectionOptions,
} from "@tanstack/react-db";
import { z } from "zod";

export const appSettingsSchema = z.object({
	id: z.string(),
	systemPrompt: z.string(),
	updatedAt: z.number(),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const APP_SETTINGS_STORAGE_KEY = "mintranslate.appSettings";
export const APP_SETTINGS_ID = "app";

export const appSettingsCollection = createCollection(
	localStorageCollectionOptions({
		id: "app-settings",
		storageKey: APP_SETTINGS_STORAGE_KEY,
		getKey: (item) => item.id,
		schema: appSettingsSchema,
	}),
);
