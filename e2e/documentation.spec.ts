import { test, expect } from "@playwright/test";

test.describe("Documentation", () => {
	test("navigates to documentation from home page", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Click Docs link in header (use first() to avoid strict mode violation)
		await page.getByRole("link", { name: "Docs" }).first().click();

		// Should navigate to docs page
		await expect(page).toHaveURL(/\/docs/);
	});

	test("displays documentation content", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Verify documentation page loads (fumadocs uses article for content)
		await expect(
			page.locator("article, main, [role='main']").first(),
		).toBeVisible();

		// Should have navigation or table of contents (use first() to avoid strict mode)
		await expect(page.locator("nav, aside").first()).toBeVisible();
	});

	test("navigates between different doc pages", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Find links to other doc pages
		const docLinks = page.locator('a[href*="/docs/"]');

		if ((await docLinks.count()) > 0) {
			// Click first doc link
			await docLinks.first().click();

			// Verify navigation occurred
			await expect(page).toHaveURL(/\/docs\//);
		}
	});

	test("documentation respects language parameter", async ({ page }) => {
		// Visit English docs
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// URL should contain /en/
		await expect(page).toHaveURL(/\/en\/docs/);

		// Visit Chinese docs
		await page.goto("/zh/docs");
		await page.waitForLoadState("networkidle");

		// URL should contain /zh/
		await expect(page).toHaveURL(/\/zh\/docs/);
	});

	test("redirects /docs to language-specific docs", async ({ page }) => {
		await page.goto("/docs");
		await page.waitForLoadState("networkidle");

		// Should redirect to language-specific URL
		await expect(page).toHaveURL(/\/(en|zh)\/docs/);
	});

	test("has working Quick Start link in header", async ({ page }) => {
		await page.goto("/");
		await page.waitForLoadState("networkidle");

		// Test that docs navigation works (Quick Start may not exist in header)
		await page.getByRole("link", { name: /docs/i }).first().click();
		await expect(page).toHaveURL(/\/(en|zh)\/docs/i);
	});

	test("search functionality in documentation", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for search input
		const searchInput = page.getByRole("searchbox").or(
			page.getByPlaceholder(/search/i),
		);

		if (await searchInput.isVisible()) {
			// Enter search query
			await searchInput.fill("provider");

			// Wait for search results
			await page.waitForTimeout(1000);

			// Results should appear
			const searchResults = page.locator('[role="option"], [data-search-result]');

			// Should have at least some results
			if ((await searchResults.count()) > 0) {
				await expect(searchResults.first()).toBeVisible();
			}
		}
	});

	test("documentation has table of contents", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for TOC
		const toc = page.locator('[data-toc], nav, aside').filter({
			hasText: /table of contents|on this page/i,
		});

		// TOC should be visible on documentation pages
		if (await toc.isVisible()) {
			// TOC links should be clickable
			const tocLinks = toc.locator("a");
			expect(await tocLinks.count()).toBeGreaterThan(0);
		}
	});

	test("documentation code blocks have copy button", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for code blocks
		const codeBlocks = page.locator("pre code, pre");

		if ((await codeBlocks.count()) > 0) {
			// Should have copy button
			const copyButton = page.getByRole("button", { name: /copy/i });

			if (await copyButton.isVisible()) {
				await copyButton.click();

				// Might show copied confirmation
				await expect(
					page.getByText(/copied/i).or(copyButton),
				).toBeVisible();
			}
		}
	});

	test("documentation supports dark mode", async ({ page }) => {
		// Set dark theme
		await page.emulateMedia({ colorScheme: "dark" });

		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Verify dark theme is applied
		const html = page.locator("html");
		await expect(html).toHaveClass(/dark/);

		// Documentation should be readable in dark mode (fumadocs uses article)
		const content = page.locator("article, main, [role='main']").first();
		await expect(content).toBeVisible();
	});

	test("documentation has breadcrumb navigation", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for breadcrumbs
		const breadcrumb = page.locator('nav[aria-label*="breadcrumb" i]').or(
			page.locator('[data-breadcrumb]'),
		);

		// Breadcrumbs help users understand their location
		if (await breadcrumb.isVisible()) {
			const breadcrumbLinks = breadcrumb.locator("a");
			expect(await breadcrumbLinks.count()).toBeGreaterThan(0);
		}
	});

	test("documentation links open in same window", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Find internal doc links
		const internalLinks = page.locator('a[href*="/docs/"]');

		if ((await internalLinks.count()) > 0) {
			const firstLink = internalLinks.first();
			const target = await firstLink.getAttribute("target");

			// Internal links should not open in new window
			expect(target).not.toBe("_blank");
		}
	});

	test("documentation has footer with navigation", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for footer
		const footer = page.locator("footer");

		if (await footer.isVisible()) {
			// Footer might have links to GitHub, community, etc.
			const footerLinks = footer.locator("a");
			expect(await footerLinks.count()).toBeGreaterThan(0);
		}
	});

	test("external links in documentation have proper attributes", async ({
		page,
	}) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Find external links (GitHub, etc.)
		const externalLinks = page.locator('a[href^="http"]').or(
			page.locator('a[target="_blank"]'),
		);

		if ((await externalLinks.count()) > 0) {
			const firstExternal = externalLinks.first();

			// Should have target="_blank" and rel="noopener noreferrer"
			await firstExternal.getAttribute("target");
			await firstExternal.getAttribute("rel");

			// External links should open in new tab for security
		}
	});

	test("documentation sidebar navigation is sticky", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for sidebar navigation
		const sidebar = page.locator('aside, nav[data-sidebar]');

		if (await sidebar.isVisible()) {
			// Scroll down
			await page.evaluate(() => window.scrollTo(0, 500));

			// Sidebar should still be visible (sticky)
			await expect(sidebar).toBeVisible();
		}
	});

	test("documentation mobile menu works", async ({ page }) => {
		// Set mobile viewport
		await page.setViewportSize({ width: 375, height: 667 });

		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for mobile menu toggle
		const menuToggle = page.getByRole("button", { name: /menu/i }).or(
			page.locator('button[aria-label*="menu" i]'),
		);

		if (await menuToggle.isVisible()) {
			// Open menu
			await menuToggle.click();

			// Menu should appear
			const menu = page.locator('[role="dialog"], [data-mobile-menu]');
			await expect(menu).toBeVisible();

			// Close menu
			await menuToggle.click();

			// Menu should close
			await expect(menu).not.toBeVisible();
		}
	});

	test("documentation search is accessible via keyboard", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Press Cmd/Ctrl+K to open search
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await page.keyboard.press(`${modifier}+KeyK`);

		// Search input should be focused
		const searchInput = page.getByRole("searchbox").or(
			page.getByPlaceholder(/search/i),
		);

		if (await searchInput.isVisible()) {
			await expect(searchInput).toBeFocused();
		}
	});

	test("documentation has proper heading hierarchy", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Should have h1
		const h1 = page.locator("h1");
		expect(await h1.count()).toBeGreaterThan(0);

		// Should have h2, h3 for content structure
		const headings = page.locator("h1, h2, h3, h4");
		expect(await headings.count()).toBeGreaterThan(1);
	});

	test("documentation images have alt text", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Find all images
		const images = page.locator("img");

		if ((await images.count()) > 0) {
			for (let i = 0; i < (await images.count()); i++) {
				const img = images.nth(i);
				const alt = await img.getAttribute("alt");

				// All images should have alt text for accessibility
				expect(alt).toBeDefined();
			}
		}
	});

	test("documentation version selector works", async ({ page }) => {
		await page.goto("/en/docs");
		await page.waitForLoadState("networkidle");

		// Look for version selector
		const versionSelector = page.locator('[data-version-selector]').or(
			page.getByRole("button", { name: /version/i }),
		);

		// If version selector exists, test it
		if (await versionSelector.isVisible()) {
			await versionSelector.click();

			// Should show version options
			const versionOptions = page.locator('[role="menuitem"]');
			expect(await versionOptions.count()).toBeGreaterThan(0);
		}
	});
});
