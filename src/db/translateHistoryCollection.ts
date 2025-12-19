import {
	type Collection,
	createCollection,
	localOnlyCollectionOptions,
} from "@tanstack/react-db";
import { z } from "zod";

import { indexedDBCollectionOptions } from "@/db/indexedDBCollectionOptions";

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

const LEGACY_TRANSLATE_HISTORY_STORAGE_KEY = "mintranslate.translateHistory";

export const TRANSLATE_HISTORY_DB_NAME = "mintranslate";
export const TRANSLATE_HISTORY_DB_STORE_NAME = "translate-history";
export const TRANSLATE_HISTORY_DB_VERSION = 1;

function clearLegacyHistoryFromLocalStorage() {
	try {
		globalThis.localStorage?.removeItem(LEGACY_TRANSLATE_HISTORY_STORAGE_KEY);
	} catch {
		// ignore
	}
}

clearLegacyHistoryFromLocalStorage();

export const translateHistoryCollection = (
	typeof globalThis.indexedDB === "undefined"
		? createCollection(
				localOnlyCollectionOptions({
					id: "translate-history",
					getKey: (item) => item.id,
					schema: translateHistoryItemSchema,
				}),
			)
		: createCollection(
				indexedDBCollectionOptions({
					id: "translate-history",
					databaseName: TRANSLATE_HISTORY_DB_NAME,
					storeName: TRANSLATE_HISTORY_DB_STORE_NAME,
					version: TRANSLATE_HISTORY_DB_VERSION,
					indexes: [{ name: "createdAt", keyPath: "value.createdAt" }],
					getKey: (item) => item.id,
					schema: translateHistoryItemSchema,
				}),
			)
) as Collection<TranslateHistoryItem, string>;

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
