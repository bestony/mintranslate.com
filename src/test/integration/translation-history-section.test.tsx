import type { Collection } from "@tanstack/react-db";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslateHistoryItem } from "@/db/translateHistoryCollection";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
		<a href={String(to)} {...props}>
			{children}
		</a>
	),
}));

describe("TranslationHistorySectionClient integration", () => {
	beforeEach(() => {
		vi.resetModules();
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	});

	async function clearHistory(
		collection: Collection<TranslateHistoryItem, string>,
	) {
		await collection.preload();
		const keys = Array.from(collection.state.keys());
		if (!keys.length) return;
		const tx = collection.delete(keys);
		await tx.isPersisted.promise;
	}

	it("renders the latest 3 history items and enables View all", async () => {
		const [
			{ default: TranslationHistorySectionClient },
			{ translateHistoryCollection },
			{ appI18n },
		] = await Promise.all([
			import("@/components/TranslationHistorySectionClient"),
			import("@/db/translateHistoryCollection"),
			import("@/lib/app-i18n"),
		]);

		await appI18n.changeLanguage("en");
		await clearHistory(translateHistoryCollection);

		const items: TranslateHistoryItem[] = [
			{
				id: "1",
				createdAt: 1,
				sourceLang: "zh",
				targetLang: "en",
				sourceText: "source-1",
				translatedText: "translated-1",
			},
			{
				id: "2",
				createdAt: 2,
				sourceLang: "zh",
				targetLang: "en",
				sourceText: "source-2",
				translatedText: "translated-2",
			},
			{
				id: "3",
				createdAt: 3,
				sourceLang: "zh",
				targetLang: "en",
				sourceText: "source-3",
				translatedText: "translated-3",
			},
			{
				id: "4",
				createdAt: 4,
				sourceLang: "zh",
				targetLang: "en",
				sourceText: "source-4",
				translatedText: "translated-4",
			},
		];

		for (const item of items) {
			const tx = translateHistoryCollection.insert(item);
			await tx.isPersisted.promise;
		}

		render(
			<I18nextProvider i18n={appI18n}>
				<TranslationHistorySectionClient />
			</I18nextProvider>,
		);

		await screen.findByText("source-4");

		expect(screen.queryByText("source-1")).toBeNull();
		expect(screen.getByText("translated-4")).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		const viewAllLink = screen.getByRole("link", { name: "View all" });
		expect(viewAllLink.getAttribute("href")).toBe("/history");
	});
});
