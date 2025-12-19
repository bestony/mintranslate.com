import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { visualizer } from "rollup-plugin-visualizer";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";
import * as MdxConfig from "./source.config";

export default defineConfig(({ command }) => ({
	resolve: {
		alias: [{ find: /^ollama$/, replacement: "ollama/browser" }],
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					const normalizedId = id.replaceAll("\\", "/");

					if (normalizedId.includes("/src/components/ui/"))
						return "ui-primitives";
					if (normalizedId.includes("/src/stores/")) return "app-store";
					if (normalizedId.includes("/src/db/")) return "app-db";

					if (!normalizedId.includes("/node_modules/")) return;

					if (
						normalizedId.includes("/node_modules/react/") ||
						normalizedId.includes("/node_modules/react-dom/") ||
						normalizedId.includes("/node_modules/scheduler/")
					)
						return "vendor-react";

					if (
						normalizedId.includes("/node_modules/@tanstack/react-router/") ||
						normalizedId.includes("/node_modules/@tanstack/router-core/") ||
						normalizedId.includes(
							"/node_modules/@tanstack/router-generator/",
						) ||
						normalizedId.includes("/node_modules/@tanstack/react-start/") ||
						normalizedId.includes("/node_modules/@tanstack/start-")
					)
						return "vendor-tanstack-router";

					if (normalizedId.includes("/node_modules/@tanstack/react-db/"))
						return "vendor-tanstack-db";

					// Keep adapters split so dynamic imports don't pull every provider.
					if (normalizedId.includes("/node_modules/@tanstack/ai-openai/"))
						return "vendor-ai-openai";
					if (normalizedId.includes("/node_modules/@tanstack/ai-anthropic/"))
						return "vendor-ai-anthropic";
					if (normalizedId.includes("/node_modules/@tanstack/ai-gemini/"))
						return "vendor-ai-gemini";
					if (normalizedId.includes("/node_modules/@tanstack/ai-ollama/"))
						return "vendor-ai-ollama";
					if (normalizedId.includes("/node_modules/@tanstack/ai/"))
						return "vendor-ai-core";

					if (
						normalizedId.includes("/node_modules/@tanstack/react-store/") ||
						normalizedId.includes("/node_modules/@tanstack/store/")
					)
						return "vendor-tanstack-store";

					if (normalizedId.includes("/node_modules/@tanstack/"))
						return "vendor-tanstack";
					if (normalizedId.includes("/node_modules/@radix-ui/"))
						return "vendor-radix";

					if (
						normalizedId.includes("/node_modules/i18next/") ||
						normalizedId.includes("/node_modules/react-i18next/")
					)
						return "vendor-i18n";

					if (
						normalizedId.includes("/node_modules/fumadocs-") ||
						normalizedId.includes("/node_modules/fumadocs-core/") ||
						normalizedId.includes("/node_modules/fumadocs-ui/")
					)
						return "vendor-docs";

					if (
						normalizedId.includes("/node_modules/lucide-react/") ||
						normalizedId.includes("/node_modules/sonner/") ||
						normalizedId.includes("/node_modules/next-themes/")
					)
						return "vendor-ui";
				},
			},
		},
	},
	plugins: [
		command === "serve" && devtools(),
		nitro(),
		viteTsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
		tailwindcss(),
		mdx(MdxConfig),
		tanstackStart(),
		viteReact(),
		process.env.ANALYZE
			? visualizer({
					open: true,
					brotliSize: true,
					filename: "report.html",
				})
			: undefined,
	],
}));
