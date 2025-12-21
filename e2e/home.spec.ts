import { test, expect } from "@playwright/test";

test.describe("home", () => {
	test("shows translator shell and provider warning when no provider is set", async ({
		page,
	}) => {
		await page.goto("/");

		await expect(
			page.getByRole("heading", { name: "MinTranslate" }),
		).toBeVisible();
		const header = page.locator("header");
		await expect(
			header.getByRole("link", { name: "Docs" }),
		).toBeVisible();
		await expect(
			header.getByRole("link", { name: "Quick Start" }),
		).toBeVisible();

		const sourceArea = page.getByPlaceholder(
			/Enter the text you want to translate/i,
		);
		await sourceArea.fill("hello world");

		await expect(
			page.getByRole("alert", { name: "Provider required" }),
		).toBeVisible();
	});

	test("clears the source textarea", async ({ page }) => {
		await page.goto("/");

		const sourceArea = page.getByPlaceholder(
			/Enter the text you want to translate/i,
		);
		await sourceArea.fill("hello world");
		await expect(sourceArea).toHaveValue("hello world");

		await page.getByRole("button", { name: "Clear" }).click();
		await expect(sourceArea).toHaveValue("");
	});

	test("shows provider dropdown and allows switching providers", async ({
		page,
	}) => {
		await page.addInitScript(
			({ providers, defaultProviderId }) => {
				window.localStorage?.setItem(
					"mintranslate.aiProviders",
					JSON.stringify(providers),
				);
				window.localStorage?.setItem(
					"mintranslate.aiDefaultProviderId",
					defaultProviderId,
				);
			},
			{
				defaultProviderId: "p2",
				providers: [
					{
						id: "p1",
						type: "openai",
						name: "OpenAI",
						model: "gpt-4.1-mini",
						apiKey: "key",
					},
					{
						id: "p2",
						type: "gemini",
						name: "Gemini",
						model: "gemini-2.5-flash",
						apiKey: "key",
					},
				],
			},
		);

		await page.goto("/");

		const trigger = page.getByRole("button", {
			name: "Gemini - gemini-2.5-flash",
		});
		await expect(trigger).toBeVisible();
		await trigger.click();

		await expect(
			page.getByRole("menuitem", { name: "OpenAI - gpt-4.1-mini" }),
		).toBeVisible();
		await expect(
			page.getByRole("menuitem", { name: "Gemini - gemini-2.5-flash" }),
		).toBeVisible();

		const settingsLink = page.getByRole("menuitem", {
			name: "Edit Model Settings",
		});
		await expect(settingsLink).toBeVisible();
		await expect(settingsLink).toHaveAttribute("href", "/settings");

		await page.getByRole("menuitem", { name: "OpenAI - gpt-4.1-mini" }).click();
		await expect(
			page.getByRole("button", { name: "OpenAI - gpt-4.1-mini" }),
		).toBeVisible();
	});
});
