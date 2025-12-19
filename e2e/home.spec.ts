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
});
