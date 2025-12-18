import { defineConfig } from "vitest/config";
import viteTsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [
		viteTsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
	],
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		clearMocks: true,
		mockReset: true,
		restoreMocks: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			reportsDirectory: "./coverage",
			all: true,
			include: [
				"src/lib/**/*.{ts,tsx}",
				"src/db/**/*.{ts,tsx}",
				"src/stores/**/*.{ts,tsx}",
				"src/hooks/**/*.{ts,tsx}",
			],
			exclude: [
				"src/lib/source.ts",
				"src/locales/**",
				"src/routeTree.gen.ts",
				"src/components/ui/**",
				"src/routes/**",
			],
			thresholds: {
				lines: 100,
				functions: 100,
				statements: 100,
				branches: 100,
			},
		},
	},
});
