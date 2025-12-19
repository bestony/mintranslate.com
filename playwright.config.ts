import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	use: {
		baseURL: "http://localhost:3000",
		locale: "en-US",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bun run dev",
		url: "http://localhost:3000",
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		stderr: "pipe",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	testDir: "./e2e",
	fullyParallel: true,
});
