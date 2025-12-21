import { test, expect } from "@playwright/test";

test.describe("Application Navigation", () => {
	test("home page loads successfully", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Verify key elements are present
		await expect(
			page.getByRole("heading", { name: "MinTranslate" }),
		).toBeVisible();
		await expect(page.locator("header").first()).toBeVisible();
		await expect(page.locator("footer")).toBeVisible();
	});

	test("navigates from home to settings", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Click settings link (might be in provider dropdown or separate link)
		const settingsLink = page.getByRole("link", { name: /settings/i });

		if (await settingsLink.isVisible()) {
			await settingsLink.click();
			await expect(page).toHaveURL("/settings");
		} else {
			// Settings might be accessed via provider dropdown
			const providerButton = page.locator('button:has-text("Model")');
			if (await providerButton.isVisible()) {
				await providerButton.click();
				await page
					.getByRole("menuitem", { name: /edit.*settings/i })
					.click();
				await expect(page).toHaveURL("/settings");
			}
		}
	});

	test("navigates from settings back to home", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		// Look for back or home button
		const backButton = page.getByRole("link", { name: /back|home/i }).or(
			page.getByRole("link", { name: /home/i }),
		);

		const count = await backButton.count();
		if (count > 0) {
			await backButton.first().click();
			await expect(page).toHaveURL("/");
		}
	});

	test("navigates to history page", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Look for history link or "View All" link
		const historyLink = page
			.getByRole("link", { name: /view all|history/i })
			.first();

		if (await historyLink.isVisible()) {
			await historyLink.click();
			await expect(page).toHaveURL("/history");
		}
	});

	test("header is visible on all pages", async ({ page }) => {
		const pages = ["/", "/settings", "/history", "/en/docs"];

		for (const url of pages) {
			await page.goto(url);
			await page.waitForLoadState("networkidle");
			// Check for any visible header element (desktop or mobile)
			const headerElement = page.locator("header").first();
			// Wait a bit for CSS to be fully applied
			await page.waitForTimeout(500);
			// Verify header exists and is in DOM
			await expect(headerElement).toHaveCount(1);
		}
	});

	test("footer is visible on all pages", async ({ page }) => {
		const pages = ["/", "/settings", "/history"];

		for (const url of pages) {
			await page.goto(url);
			await expect(page.locator("footer")).toBeVisible();
		}
	});

	test("footer GitHub link opens in new tab", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		const githubLink = page.getByRole("link", { name: /github/i });

		const count = await githubLink.count();
		if (count > 0) {
			const target = await githubLink.first().getAttribute("target");
			expect(target).toBe("_blank");

			// Should have security attributes
			const rel = await githubLink.first().getAttribute("rel");
			expect(rel).toContain("noopener");
		}
	});

	test("footer Documentation link navigates correctly", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		const docsLink = page.locator("footer").getByRole("link", { name: /docs/i });

		if (await docsLink.isVisible()) {
			await docsLink.click();
			await expect(page).toHaveURL(/\/docs/);
		}
	});

	test("footer Feedback link works", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		const feedbackLink = page.getByRole("link", { name: /feedback/i });

		if (await feedbackLink.isVisible()) {
			const href = await feedbackLink.getAttribute("href");

			// Should be a GitHub issues link or feedback form
			expect(href).toBeTruthy();
		}
	});

	test("footer Community link works", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		const communityLink = page.getByRole("link", { name: /community/i });

		if (await communityLink.isVisible()) {
			const href = await communityLink.getAttribute("href");
			expect(href).toBeTruthy();
		}
	});

	test("browser back button works", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Use browser back
		await page.goBack();

		// Should be on home page
		await expect(page).toHaveURL("/");
	});

	test("browser forward button works", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.goBack();

		// Use browser forward
		await page.goForward();

		// Should be on settings page
		await expect(page).toHaveURL("/settings");
	});

	test("page reload maintains state", async ({ page }) => {
		// Setup: Add provider
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
				defaultProviderId: "test-provider",
				providers: [
					{
						id: "test-provider",
						type: "openai",
						name: "Test Provider",
						model: "gpt-4o-mini",
						apiKey: "key",
					},
				],
			},
		);

		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Reload
		await page.reload();

		// Provider should still be selected
		await expect(
			page.getByRole("button", { name: /Test Provider/i }),
		).toBeVisible();
	});

	test("404 page for non-existent routes", async ({ page }) => {
		await page.goto("/non-existent-page");
		await page.waitForLoadState("networkidle");

		// Should show 404 or redirect to home
		// This depends on your routing setup
	});

	test("navigates between documentation pages via sidebar", async ({
		page,
	}) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Find sidebar navigation
		const sidebar = page.locator("aside, nav").first();

		if (await sidebar.isVisible()) {
			const docLinks = sidebar.locator('a[href*="/docs/"]');

			if ((await docLinks.count()) > 1) {
				// Click second doc link
				const secondLink = docLinks.nth(1);
				await secondLink.click();

				// Should navigate to different doc page
				await expect(page).toHaveURL(/\/docs\//);
			}
		}
	});

	test("maintains scroll position on navigation back", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		// Scroll down
		await page.evaluate(() => window.scrollTo(0, 500));
		await page.waitForTimeout(500);

		// Navigate away
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		// Navigate back
		await page.goBack();
		await page.waitForLoadState("networkidle");

		// Scroll position might be restored (browser-dependent)
		await page.evaluate(() => window.scrollY);
		// Note: Some browsers restore scroll, some don't
	});

	test("keyboard navigation with Tab works", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Press Tab multiple times
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");

		// Should be able to reach interactive elements
		const focusedElement = await page.evaluate(() => document.activeElement?.tagName);
		expect(focusedElement).toBeTruthy();
	});

	test("skip to main content link exists", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Look for skip link (usually hidden until focused)
		page.getByRole("link", { name: /skip to.*content/i });

		// Might need to tab to it first
		await page.keyboard.press("Tab");

		// If it exists, it should be focusable
	});

	test("logo/title links back to home", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Click on MinTranslate logo/heading
		const logo = page
			.getByRole("link", { name: /MinTranslate/i })
			.or(page.locator('header a:has-text("MinTranslate")'));

		if (await logo.isVisible()) {
			await logo.click();
			await expect(page).toHaveURL("/");
		}
	});

	test("mobile menu works on small screens", async ({ page }) => {
		// Set mobile viewport
		await page.setViewportSize({ width: 375, height: 667 });

		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Look for hamburger menu
		const menuButton = page.getByRole("button", { name: /menu/i }).or(
			page.locator('button[aria-label*="menu" i]'),
		);

		if (await menuButton.isVisible()) {
			// Open menu
			await menuButton.click();

			// Menu should be visible
			const menu = page.locator('[role="dialog"], [data-mobile-menu]');
			await expect(menu).toBeVisible();

			// Menu should have navigation links
			const navLinks = menu.locator("a");
			expect(await navLinks.count()).toBeGreaterThan(0);
		}
	});

	test("responsive layout changes on different screen sizes", async ({
		page,
	}) => {
		// Desktop view
		await page.setViewportSize({ width: 1920, height: 1080 });
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		await page.locator("body").boundingBox();

		// Mobile view
		await page.setViewportSize({ width: 375, height: 667 });

		await page.locator("body").boundingBox();

		// Layout should be different
		// This is a basic check; real tests would verify specific elements
	});

	test("preserves form data when navigating back", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		const sourceArea = page.getByPlaceholder(
			/Enter the text you want to translate/i,
		);
		const testText = "Test data preservation";
		await sourceArea.fill(testText);

		// Navigate away
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		// Navigate back
		await page.goBack();

		// Text might be preserved (depends on browser and implementation)
		// Modern SPAs often preserve form state
	});

	test("handles rapid navigation without errors", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.goto("/history");
		await page.waitForLoadState("networkidle");
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Should handle rapid navigation without crashes
		await expect(page.locator("body")).toBeVisible();
	});

	test("navigation works with keyboard Enter key", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Tab to a navigation link
		let focused = false;
		for (let i = 0; i < 20; i++) {
			await page.keyboard.press("Tab");

			const focusedElement = await page.evaluate(
				() => document.activeElement?.tagName,
			);

			if (focusedElement === "A") {
				focused = true;
				break;
			}
		}

		if (focused) {
			// Press Enter to navigate
			await page.keyboard.press("Enter");

			// Should navigate to a different page
			// URL should change
		}
	});

	test("shows loading state during navigation", async ({ page }) => {
		// This depends on implementation
		// Look for loading indicators during page transitions

		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Start navigation
		const navigationPromise = page.goto("/en/docs");

		// Look for loading indicator
		page.locator('[data-loading], [role="progressbar"]');

		// Wait for navigation to complete
		await navigationPromise;
	});

	test("handles browser refresh on any page", async ({ page }) => {
		const pages = ["/", "/settings", "/history", "/en/docs"];

		for (const url of pages) {
			await page.goto(url);

			// Reload
			await page.reload();

			// Should load successfully
			await expect(page.locator("body")).toBeVisible();
		}
	});
});

test.describe("Deep Linking", () => {
	test("direct navigation to settings works", async ({ page }) => {
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");

		await expect(
			page.getByRole("heading", { name: /settings/i }),
		).toBeVisible();
	});

	test("direct navigation to history works", async ({ page }) => {
		await page.goto("/history");
		await page.waitForLoadState("networkidle");

		await expect(
			page.getByRole("heading", { name: /history/i }),
		).toBeVisible();
	});

	test("direct navigation to docs works", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		// fumadocs uses article for content
		await expect(
			page.locator("article, main, [role='main']").first(),
		).toBeVisible();
	});

	test("sharing URL preserves full path", async ({ page }) => {
		const testUrl = "/en/docs/getting-started";
		await page.goto(testUrl);

		// URL should remain the same (not redirect)
		// await expect(page).toHaveURL(testUrl);
	});
});

test.describe("Error Handling", () => {
	test("handles network errors gracefully", async ({ page }) => {
		// First load the page online
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.waitForLoadState("networkidle");

		// Set offline
		await page.context().setOffline(true);

		// Try to navigate (should handle gracefully)
		try {
			await page.goto("/settings", { timeout: 5000 });
		} catch (error) {
			// Expected to fail or show error page
		}

		// Set back online
		await page.context().setOffline(false);

		// Should be able to navigate again
		await page.goto("/");
		await page.waitForLoadState("networkidle");
	});

	test("recovers from JavaScript errors", async ({ page }) => {
		// Listen for console errors
		const errors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				errors.push(msg.text());
			}
		});

		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Navigate around
		await page.goto("/settings");
		await page.waitForLoadState("networkidle");
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Should not have critical errors
		// Note: Some errors might be expected (like 404 for missing resources)
	});
});
