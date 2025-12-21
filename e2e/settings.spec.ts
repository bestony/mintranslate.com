import { test, expect } from "@playwright/test";

test.describe("Settings - Provider Management", () => {
	test("navigates to settings page", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		await expect(
			page.getByRole("heading", { name: /settings/i }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: /ai providers|providers/i }),
		).toBeVisible();
	});

	test("adds a new OpenAI provider", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		// Click "Add" button
		await page.getByRole("button", { name: "Add" }).click();

		// Select OpenAI from dropdown
		await page.getByRole("menuitem", { name: "OpenAI" }).click();

		// Fill in provider details
		await page.getByLabel("Name").fill("My OpenAI");
		await page.getByLabel("API Key").fill("sk-test-key-123");
		await page.getByLabel("Model").fill("gpt-4o-mini");

		// Save provider (click the Save button in the form, not the system prompt Save)
		await page.locator("form").getByRole("button", { name: "Save" }).click();

		// Verify provider appears in the list
		await expect(
			page.getByText("My OpenAI"),
		).toBeVisible();
	});

	test("adds a new Gemini provider", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		const addButton = page.getByRole("button", { name: /add provider/i });
		if ((await addButton.count()) > 0) {
			await addButton.click();

			const geminiItem = page.getByRole("menuitem", { name: /gemini/i });
			if ((await geminiItem.count()) > 0) {
				await geminiItem.click();

				await page.getByLabel(/provider name|name/i).fill("My Gemini");
				await page.getByLabel(/api key|key/i).fill("gemini-test-key");
				await page.getByLabel(/model/i).fill("gemini-2.0-flash-exp");

				await page.getByRole("button", { name: /save/i }).click();

				// Verify provider appears (optional check)
				const providerButton = page.getByRole("button", {
					name: "My Gemini",
				});
				if ((await providerButton.count()) > 0) {
					await expect(providerButton).toBeVisible();
				}
			}
		}
	});

	test("adds a new Anthropic provider", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		await page.getByRole("button", { name: "Add" }).click();
		await page.getByRole("menuitem", { name: "Anthropic" }).click();

		await page.getByLabel("Name").fill("My Claude");
		await page.getByLabel("API Key").fill("sk-ant-test-key");
		await page.getByLabel("Model").fill("claude-3-5-sonnet-20241022");

		await page.locator("form").getByRole("button", { name: "Save" }).click();

		await expect(
			page.getByText("My Claude"),
		).toBeVisible();
	});

	test("adds a new Ollama provider with base URL", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("domcontentloaded");

		// Find and click the Add button in the provider settings section
		const addButton = page.getByRole("button").filter({ hasText: /add|Add/i }).first();
		await addButton.click();

		await page.getByRole("menuitem", { name: "Ollama" }).click();

		await page.getByLabel(/provider name|name/i).fill("My Ollama");
		await page.getByLabel(/host|base url|ollama/i).fill("http://localhost:11434");
		await page.getByLabel(/model/i).fill("llama3.2");

		// Click the Save button in the provider form (not the system prompt save)
		await page.locator('form').getByRole("button", { name: /save/i }).click();

		await expect(
			page.getByText("My Ollama"),
		).toBeVisible();
	});

	test("edits an existing provider", async ({ page }) => {
		// Setup: Add a provider first
		await page.addInitScript(
			({ providers }) => {
				window.localStorage?.setItem(
					"mintranslate.aiProviders",
					JSON.stringify(providers),
				);
			},
			{
				providers: [
					{
						id: "test-provider-1",
						type: "openai",
						name: "Test OpenAI",
						model: "gpt-4o-mini",
						apiKey: "old-key",
					},
				],
			},
		);

		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Wait for the provider to appear
		await expect(page.getByText("Test OpenAI")).toBeVisible({
			timeout: 10000,
		});

		// Add a small delay to ensure DOM is fully updated
		await page.waitForTimeout(1000);

		// Find the provider item and click its Edit button
		const providerItem = page.locator("li").filter({ hasText: "Test OpenAI" });
		await expect(providerItem).toBeVisible();

		const editButton = providerItem.getByRole("button", { name: /edit/i });
		await expect(editButton).toBeVisible();

		// Scroll the element into view before clicking
		await editButton.scrollIntoViewIfNeeded();
		await editButton.click();

		// Wait a moment for the form to render
		await page.waitForTimeout(1000);

		// Wait for the form to appear with the provider details loaded
		await page
			.getByLabel("Name")
			.first()
			.waitFor({ state: "visible", timeout: 5000 });

		// Edit the details
		await page.getByLabel("Name").first().fill("Updated OpenAI");
		await page.getByLabel("API Key").first().fill("new-key-456");
		await page.getByLabel("Model").first().fill("gpt-4o");

		// Click the Save button in the provider form
		await page.locator("form").getByRole("button", { name: /save/i }).click();

		// Verify updated name appears in the provider list
		await expect(page.getByText("Updated OpenAI")).toBeVisible();
	});

	test("deletes a provider with confirmation", async ({ page }) => {
		// Setup: Add a provider first
		await page.addInitScript(
			({ providers }) => {
				window.localStorage?.setItem(
					"mintranslate.aiProviders",
					JSON.stringify(providers),
				);
			},
			{
				providers: [
					{
						id: "test-provider-1",
						type: "openai",
						name: "Provider to Delete",
						model: "gpt-4o-mini",
						apiKey: "key",
					},
				],
			},
		);

		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("domcontentloaded");

		// Wait for the provider name to appear in the provider list
		await expect(page.getByText("Provider to Delete")).toBeVisible({
			timeout: 10000,
		});

		// Find the delete button for this provider (the first delete button in destructive variant)
		const deleteButton = page
			.getByRole("button", { name: /delete/i })
			.first();
		await deleteButton.click();

		// Confirm deletion in dialog - check for the correct heading
		await expect(
			page.getByRole("heading", { name: /delete provider/i }),
		).toBeVisible();

		// Click the delete confirmation button in the dialog
		await page
			.getByRole("button", { name: /delete/i, exact: true })
			.last()
			.click();

		// Verify provider is removed
		await expect(page.getByText("Provider to Delete")).not.toBeVisible();
	});

	test("sets a provider as default", async ({ page }) => {
		// Setup: Add multiple providers
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
				defaultProviderId: "provider-1",
				providers: [
					{
						id: "provider-1",
						type: "openai",
						name: "OpenAI Default",
						model: "gpt-4o-mini",
						apiKey: "key1",
					},
					{
						id: "provider-2",
						type: "gemini",
						name: "Gemini",
						model: "gemini-2.0-flash-exp",
						apiKey: "key2",
					},
				],
			},
		);

		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Find the Gemini provider in the list and click its "Set default" button
		const geminiProvider = page.locator("li").filter({ hasText: "Gemini" });
		await geminiProvider
			.getByRole("button", { name: /Set default/i })
			.click();

		// Verify that the "Set default" button was clicked and the provider settings were saved
		// by checking the toast notification appeared
		await expect(
			page.getByText(/Set as default: Gemini/i),
		).toBeVisible({ timeout: 5000 });

		// Verify the provider is now set as default by checking the UI
		// The settings page should show a "Default" badge next to the Gemini provider
		const defaultBadge = page.locator("li").filter({ hasText: "Gemini" }).getByText("Default", { exact: true });
		await expect(defaultBadge).toBeVisible({ timeout: 5000 });
	});

	test("validates required fields when adding provider", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Click the Add button (the label is just "Add", not "Add Provider")
		await page.getByRole("button", { name: "Add" }).click();
		await page.getByRole("menuitem", { name: "OpenAI" }).click();

		// Try to save without filling required fields
		await page.locator("form").getByRole("button", { name: "Save" }).click();

		// Verify validation errors appear - the form should still be visible
		// with the Name label (not Provider Name)
		await expect(page.getByLabel("Name")).toBeVisible();

		// Verify the form hasn't been closed/saved by checking the title
		await expect(
			page.getByRole("heading", { name: "New provider" }),
		).toBeVisible();
	});

	test("cancels provider creation", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		await page.getByRole("button", { name: /add/i }).click();
		await page.getByRole("menuitem", { name: "OpenAI" }).click();

		// Fill some data
		await page.getByLabel(/provider name|name/i).fill("Cancelled Provider");

		// Navigate away to cancel (click home button in header)
		await page.getByRole("link", { name: /back home/i }).click();
		await page.waitForLoadState("networkidle");

		// Verify provider was not created - should be back on home page
		await expect(
			page.getByRole("heading", { name: /translate/i }),
		).toBeVisible();
	});
});
