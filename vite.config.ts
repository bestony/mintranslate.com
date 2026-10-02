import tailwindcss from "@tailwindcss/vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { normalizeBasePath, toViteBase } from "./src/lib/base-path";

// Single source of truth for the deployment base path. See design.md D3.
const basePath = normalizeBasePath(process.env.VITE_BASE_PATH);

/** Deployable static output. This is the directory to publish. */
const STATIC_OUTPUT_DIR = "dist";

/** Build-time intermediate output. Never deployed, never scanned. */
const INTERMEDIATE_OUTPUT_DIR = ".tanstack/ssr";

// Printed once per build so the effective base path is verifiable from build
// output, and so a misconfigured value is visible before the build proceeds.
console.log(`[mintranslate] base path: ${basePath}`);

export default defineConfig({
	base: toViteBase(basePath),
	resolve: {
		tsconfigPaths: true,
		alias: [
			// `@tanstack/ai-ollama` imports `ollama`, whose default entry point pulls
			// in `node:fs` and `node:path`. Those cannot run in a browser and would
			// end up as stubbed externals in the bundle. Pointing the bare specifier
			// at the package's browser build keeps the Node built-ins out entirely.
			// The pattern is anchored so `ollama/browser` itself is left alone.
			{ find: /^ollama$/, replacement: "ollama/browser" },
		],
	},
	environments: {
		// The client environment produces the deployable artifact, and it owns
		// `STATIC_OUTPUT_DIR` directly so the directory to publish is not a
		// `client/` subdirectory.
		client: { build: { outDir: STATIC_OUTPUT_DIR } },
		// The SSR bundle exists only as a build-time intermediate: it renders the
		// SPA shell (`_shell.html`) and then has no runtime role. Emitting it
		// outside `STATIC_OUTPUT_DIR` keeps the deployable directory free of any
		// server entry, so "ship this directory" is unambiguous and the
		// no-external-refs check covers exactly what gets deployed.
		ssr: { build: { outDir: INTERMEDIATE_OUTPUT_DIR } },
	},
	// `nitro()` is intentionally absent: the Nitro plugin suppresses the SPA
	// shell (`_shell.html`), and this application must ship as static assets
	// only. See design.md D2.
	plugins: [
		tailwindcss(),
		tanstackStart({ spa: { enabled: true } }),
		viteReact(),
	],
});
