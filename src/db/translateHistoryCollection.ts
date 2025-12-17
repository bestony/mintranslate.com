import {
	createCollection,
	localStorageCollectionOptions,
} from "@tanstack/react-db";
import { z } from "zod";

const langSchema = z.enum(["zh", "en", "fr", "ja", "es"]);

export const translateHistoryItemSchema = z.object({
	id: z.string(),
	createdAt: z.number(),
	sourceLang: langSchema,
	targetLang: langSchema,
	sourceText: z.string(),
	translatedText: z.string(),
});

export type TranslateHistoryItem = z.infer<typeof translateHistoryItemSchema>;

export const TRANSLATE_HISTORY_STORAGE_KEY = "mintranslate.translateHistory";

export const translateHistoryCollection = createCollection(
	localStorageCollectionOptions({
		id: "translate-history",
		storageKey: TRANSLATE_HISTORY_STORAGE_KEY,
		getKey: (item) => item.id,
		schema: translateHistoryItemSchema,
	}),
);

function createHistoryId() {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function addTranslateHistory(
	input: Omit<TranslateHistoryItem, "id" | "createdAt"> &
		Partial<Pick<TranslateHistoryItem, "id" | "createdAt">>,
) {
	const item: TranslateHistoryItem = {
		id: input.id ?? createHistoryId(),
		createdAt: input.createdAt ?? Date.now(),
		sourceLang: input.sourceLang,
		targetLang: input.targetLang,
		sourceText: input.sourceText,
		translatedText: input.translatedText,
	};

	return translateHistoryCollection.insert(item);
}
