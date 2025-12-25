import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { act } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stopTranslateEffects, translateStore } from "@/stores/translateStore";

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();

	return {
		...actual,
		Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
			<a href={String(to)} {...props}>
				{children}
			</a>
		),
	};
});

describe("home provider menu integration", () => {
	afterEach(() => {
		cleanup();
		act(() => {
			stopTranslateEffects();
			translateStore.setState((state) => ({
				...state,
				providers: [],
				defaultProviderId: "",
			}));
		});
		globalThis.localStorage?.clear?.();
	});

	it("shows provider label and lists configured providers", async () => {
		const user = userEvent.setup();
		const providers = [
			{
				id: "p1",
				type: "openai" as const,
				name: "OpenAI",
				model: "gpt-4.1-mini",
				apiKey: "key",
			},
			{
				id: "p2",
				type: "gemini" as const,
				name: "Gemini",
				model: "gemini-2.5-flash",
				apiKey: "key",
			},
		];

		translateStore.setState((state) => ({
			...state,
			providers,
			defaultProviderId: "p2",
		}));

		const [{ Route }, { appI18n }] = await Promise.all([
			import("@/routes/index"),
			import("@/lib/app-i18n"),
		]);
		const App = (Route as { options: { component: ComponentType } }).options
			.component;

		await appI18n.changeLanguage("en");

		render(
			<I18nextProvider i18n={appI18n}>
				<App />
			</I18nextProvider>,
		);

		const trigger = await screen.findByRole("button", {
			name: "Gemini - gemini-2.5-flash",
		});
		await user.click(trigger);

		expect(
			await screen.findByRole("menuitem", {
				name: "OpenAI - gpt-4.1-mini",
			}),
		).toBeTruthy();
		expect(
			screen.getByRole("menuitem", { name: "Gemini - gemini-2.5-flash" }),
		).toBeTruthy();
		expect(
			screen.getByRole("menuitem", { name: "Edit Model Settings" }),
		).toBeTruthy();
	});
});
