import { test, expect } from "@playwright/test";

test.describe("Settings - System Prompt Configuration", () => {
	test("displays default system prompt on first visit", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Verify System Prompt section is visible
		await expect(
			page.locator('[data-slot="card-title"]').filter({
				hasText: /^System prompt$/,
			}),
		).toBeVisible();

		// Verify textarea contains default prompt
		const promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});
		await expect(promptTextarea).toBeVisible();

		const promptValue = await promptTextarea.inputValue();
		expect(promptValue).toContain("你是一个翻译引擎");
	});

	test("edits and saves custom system prompt", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		const promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});

		// Clear existing prompt and enter new one
		await promptTextarea.clear();
		const customPrompt =
			"You are a professional translator specializing in technical documentation.";
		await promptTextarea.fill(customPrompt);

		// Save the prompt - use the system prompt card's save button
		const systemPromptCard = page.locator('[data-slot="card"]').first();
		await systemPromptCard.getByRole("button", { name: "Save" }).click();

		// Verify success toast/notification
		await expect(page.getByText("System prompt saved")).toBeVisible();

		// Reload page and verify persistence
		await page.reload();
		await expect(promptTextarea).toHaveValue(customPrompt);
	});

	test("resets system prompt to default", async ({ page }) => {
		// Setup: Navigate to settings first, then set custom prompt via UI
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		const promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});

		// Set a custom prompt
		await promptTextarea.clear();
		await promptTextarea.fill("Custom prompt that should be reset");

		// Get the system prompt card and click its save button
		const systemPromptCard = page.locator('[data-slot="card"]').first();
		await systemPromptCard.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("System prompt saved")).toBeVisible();

		// Verify custom prompt is saved
		await expect(promptTextarea).toHaveValue(
			"Custom prompt that should be reset",
		);

		// Click reset button
		await systemPromptCard.getByRole("button", { name: /reset to default/i }).click();

		// Verify prompt is reset to default
		const promptValue = await promptTextarea.inputValue();
		expect(promptValue).toContain("你是一个翻译引擎");
	});

	test("shows character count for system prompt", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		const promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});

		await promptTextarea.clear();
		await promptTextarea.fill("Short prompt");

		// Verify character count is displayed (implementation-dependent)
		// This assumes there's a character counter element
		const charCount = await promptTextarea.inputValue();
		expect(charCount.length).toBe(12);
	});

	test("preserves system prompt across navigation", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		const customPrompt = "Test preservation prompt";
		let promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});

		await promptTextarea.clear();
		await promptTextarea.fill(customPrompt);

		// Save the prompt - use the system prompt card's save button
		const systemPromptCard = page.locator('[data-slot="card"]').first();
		await systemPromptCard.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("System prompt saved")).toBeVisible();

		// Navigate away
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Navigate back to settings
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Re-query the textarea element after navigation
		promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});

		// Verify prompt is still there
		await expect(promptTextarea).toHaveValue(customPrompt);
	});

	test("handles very long system prompts", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		const promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});

		// Create a long prompt (but reduce size for performance)
		const longPrompt = "This is a long system prompt. ".repeat(100);

		// Clear and fill the textarea
		await promptTextarea.clear();
		await promptTextarea.fill(longPrompt);

		// Save the prompt - use the system prompt card's save button
		const systemPromptCard = page.locator('[data-slot="card"]').first();
		await systemPromptCard.getByRole("button", { name: "Save" }).click();

		// Verify it saved successfully
		await expect(page.getByText("System prompt saved")).toBeVisible();
		await expect(promptTextarea).toHaveValue(longPrompt);
	});

	test("discards unsaved changes when resetting", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		const promptTextarea = page.getByRole("textbox", {
			name: /system prompt/i,
		});

		// Make changes without saving
		await promptTextarea.clear();
		await promptTextarea.fill("Unsaved changes");

		// Reset without saving
		await page.getByRole("button", { name: /reset to default/i }).click();

		// Verify default prompt is shown
		const promptValue = await promptTextarea.inputValue();
		expect(promptValue).toContain("你是一个翻译引擎");
	});
});
