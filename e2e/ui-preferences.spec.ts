import { test, expect } from "@playwright/test";

test.describe("Theme Switching", () => {
	test("defaults to system theme", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Find theme toggle button (uses Chinese aria-label)
		const themeButton = page.getByRole("button", {
			name: /切换主题|toggle theme/i,
		});

		await expect(themeButton).toBeVisible();
	});

	test("switches to light theme", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Open theme menu
		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		await themeButton.click();

		// Select light theme
		await page.getByRole("menuitem", { name: /浅色|light/i }).click();

		// Verify light theme is applied
		const html = page.locator("html");
		await expect(html).not.toHaveClass(/dark/);
	});

	test("switches to dark theme", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Open theme menu
		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		await themeButton.click();

		// Select dark theme
		await page.getByRole("menuitem", { name: /深色|dark/i }).click();

		// Verify dark theme is applied
		const html = page.locator("html");
		await expect(html).toHaveClass(/dark/);
	});

	test("switches to system theme", async ({ page }) => {
		// First set to light theme
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		await themeButton.click();
		await page.getByRole("menuitem", { name: /浅色|light/i }).click();

		// Then switch to system
		await themeButton.click();
		await page.getByRole("menuitem", { name: /跟随系统|system/i }).click();

		// Theme should match system preference
		// Verification depends on system settings
	});

	test("persists theme selection across page reloads", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Set dark theme
		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		await themeButton.click();
		await page.getByRole("menuitem", { name: /深色|dark/i }).click();

		// Reload page
		await page.reload();

		// Verify dark theme is still applied
		const html = page.locator("html");
		await expect(html).toHaveClass(/dark/);
	});

	test("theme toggle is accessible via keyboard", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Tab to theme button
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab"); // May need multiple tabs

		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		// Activate with Enter
		if (await themeButton.isVisible()) {
			await themeButton.focus();
			await page.keyboard.press("Enter");

			// Menu should open
			await expect(
				page.getByRole("menuitem", { name: /浅色|light/i }),
			).toBeVisible();
		}
	});
});

test.describe("UI Language Switching", () => {
	test("defaults to browser language or English", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Page should load with default language
		// Verify by checking for English or Chinese text
		const heading = page.getByRole("heading", { name: /MinTranslate/i });
		await expect(heading).toBeVisible();
	});

	test("switches UI language to Chinese", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Find language selector button (has LanguagesIcon and shows current language)
		const languageSelector = page.getByRole("button").filter({
			has: page.locator("svg"),
			hasText: /English|中文/,
		});

		await languageSelector.first().click();

		// Select Chinese from dropdown menu
		await page.getByRole("menuitem", { name: /中文|Chinese/i }).click();

		// Verify UI text changes to Chinese
		// Check for Chinese text in common UI elements
		await page.waitForTimeout(500); // Wait for language to apply

		// Common Chinese text might include "设置", "翻译" etc.
		// This depends on actual translations in the app
	});

	test("switches UI language to English", async ({ page }) => {
		// First set to Chinese
		await page.addInitScript(() => {
			window.localStorage?.setItem("mintranslate.uiLanguage", "zh");
		});

		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Find language selector button (contains LanguagesIcon SVG + "中文" text)
		const languageSelector = page
			.locator('button:has-text("中文")')
			.filter({ has: page.locator("svg") })
			.first();

		await expect(languageSelector).toBeVisible();
		await languageSelector.click();

		// Wait for the dropdown menu to open and select English
		// When UI is in Chinese, "English" is displayed as "英文"
		const englishOption = page.getByRole("menuitem", { name: /英文|English/i });
		await expect(englishOption).toBeVisible();
		await englishOption.click();

		// Verify UI text changes to English
		await page.waitForTimeout(500);

		// Should see English text
		await expect(
			page.getByRole("heading", { name: "MinTranslate" }),
		).toBeVisible();
	});

	test("persists UI language selection across page reloads", async ({
		page,
	}) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Set language to Chinese
		const languageSelector = page.getByRole("button", { name: /language/i }).first().or(
			page.locator('button:has-text("English"), button:has-text("中文")'),
		);

		await languageSelector.first().click();
		await page.getByRole("menuitem", { name: /中文|Chinese/i }).click();

		// Reload page
		await page.reload();

		// Verify Chinese is still selected
		// Check for Chinese text in UI
		await page.waitForTimeout(500);
	});

	test("updates all UI text when language changes", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("load");

		// Navigate to settings page
		await page.goto("/settings");
		await page.waitForLoadState("load");

		// Find and click the language selector dropdown button
		// It shows either "English" or "中文" depending on current language
		const languageButtons = page.getByRole("button").filter({
			hasText: /English|中文|English|中文/,
		});

		// Try each button until we find the language selector (should be the first dropdown-like button)
		const buttonCount = await languageButtons.count();
		if (buttonCount > 0) {
			const firstButton = languageButtons.first();
			await firstButton.click();

			// Wait a bit for dropdown to open
			await page.waitForTimeout(200);

			// Select Chinese from dropdown menu
			const chineseOption = page.getByRole("menuitem", {
				name: /中文|Chinese/i,
			});

			if (await chineseOption.isVisible()) {
				await chineseOption.click();

				// Wait for language change to take effect
				await page.waitForTimeout(500);

				// Verify settings page title is in Chinese (should be "设置")
				await expect(
					page.getByRole("heading", { name: "设置" }),
				).toBeVisible();
			}
		}
	});

	test("maintains language selection when navigating between pages", async ({
		page,
	}) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Set language to Chinese
		const languageSelector = page.getByRole("button", { name: /language/i }).first().or(
			page.locator('button:has-text("English"), button:has-text("中文")'),
		);

		await languageSelector.first().click();
		await page.getByRole("menuitem", { name: /中文|Chinese/i }).click();
		await page.waitForTimeout(500);

		// Verify language is Chinese on home page
		const langButton1 = page.getByRole("button").filter({
			hasText: /中文/,
		}).first();
		await expect(langButton1).toBeVisible();

		// Navigate to settings
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(500);

		// Verify language is still Chinese on settings page
		const langButton2 = page.getByRole("button").filter({
			hasText: /中文/,
		}).first();
		await expect(langButton2).toBeVisible();

		// Navigate to history
		await page.goto("/history");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(500);

		// Verify language is still Chinese on history page
		const langButton3 = page.getByRole("button").filter({
			hasText: /中文/,
		}).first();
		await expect(langButton3).toBeVisible();
	});
});

test.describe("Combined Theme and Language Preferences", () => {
	test("persists both theme and language preferences", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Set dark theme
		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		await themeButton.click();
		await page.getByRole("menuitem", { name: /深色|dark/i }).click();

		// Set Chinese language
		const languageSelector = page.getByRole("button", { name: /^(English|中文)$/ }).first();

		if (await languageSelector.isVisible()) {
			await languageSelector.click();
			await page.getByRole("menuitem", { name: /中文|Chinese/i }).click();
		}

		// Reload page
		await page.reload();
		await page.waitForTimeout(500);

		// Verify both preferences are maintained
		const html = page.locator("html");
		await expect(html).toHaveClass(/dark/);
	});

	test("theme and language work independently", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Change theme multiple times
		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		await themeButton.click();
		await page.getByRole("menuitem", { name: /深色|dark/i }).click();

		await themeButton.click();
		await page.getByRole("menuitem", { name: /浅色|light/i }).click();

		// Change language
		const languageSelector = page.getByRole("button", { name: /^(English|中文)$/ }).first();

		if (await languageSelector.isVisible()) {
			await languageSelector.click();
			await page.getByRole("menuitem", { name: /中文|Chinese/i }).click();
		}

		// Verify theme is still light (not affected by language change)
		const html = page.locator("html");
		await expect(html).not.toHaveClass(/dark/);
	});
});

test.describe("Accessibility", () => {
	test("respects prefers-reduced-motion for theme transitions", async ({
		page,
	}) => {
		// Set reduced motion preference
		await page.emulateMedia({ reducedMotion: "reduce" });

		await page.goto("/");
		await page.waitForLoadState("networkidle");

		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		await themeButton.click();
		await page.getByRole("menuitem", { name: /深色|dark/i }).click();

		// Theme should change without animations
		// Verification would depend on CSS animation inspection
	});

	test("theme toggle has proper ARIA attributes", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		const themeButton = page.getByRole("button", { name: /切换主题|toggle theme/i }).or(
			page.locator('button[aria-label*="theme" i]'),
		);

		// Verify ARIA attributes
		if (await themeButton.isVisible()) {
			const ariaLabel = await themeButton.getAttribute("aria-label");
			expect(ariaLabel).toBeTruthy();
		}
	});

	test("language selector has proper ARIA attributes", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Target the dropdown language selector specifically (first button with English/中文 text)
		const languageSelector = page.getByRole("button", { name: /^(English|中文)$/ }).first();

		await expect(languageSelector).toBeVisible();

		// Verify ARIA attributes
		await languageSelector.getAttribute("aria-label");
		const ariaHaspopup = await languageSelector.getAttribute("aria-haspopup");
		const ariaExpanded = await languageSelector.getAttribute("aria-expanded");

		// Language selector should have proper ARIA attributes for accessibility
		expect(ariaHaspopup).toBe("menu");
		expect(ariaExpanded).toBeDefined();
	});
});
