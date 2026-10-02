import tailwindcss from "@tailwindcss/vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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

/**
 * Service worker output file name.
 *
 * Kept at the base path root so its scope is the application itself. A worker
 * placed deeper would only control a sub-tree, and one placed at the site root
 * would claim paths belonging to other applications on the same origin.
 */
const SERVICE_WORKER_FILENAME = "sw.js";

/** Web app manifest output file name. */
const MANIFEST_FILENAME = "manifest.webmanifest";

/**
 * Web app manifest.
 *
 * Generated here rather than shipped as a static file in `public/`: a static copy
 * would be a second source of truth alongside the cache manifest this plugin
 * produces, and the two would drift (icons, `start_url` parameters, `scope`).
 * Keeping one source means the icon list is guaranteed to be the list that also
 * gets pre-cached.
 */
/**
 * Manifest content.
 *
 * Typed from the plugin's own option type so a field the plugin does not accept
 * is a compile error rather than a silently ignored entry.
 */
const webAppManifest: NonNullable<
	NonNullable<Partial<Parameters<typeof VitePWA>[0]>>["manifest"]
> = {
	name: "MinTranslate",
	short_name: "MinTranslate",
	description:
		"A self-hosted AI translation workbench. Bring your own model endpoint; text, images, documents and webpages stay under your control.",
	lang: "zh-CN",
	// `dir` is omitted deliberately: the manifest spec's default is `auto`, and the
	// plugin's option type does not accept that value. Omitting it is equivalent.

	// Relative so the value resolves under any mount point; the `op` parameter
	// restores the mode the user last had open.
	start_url: "./?op=translate",
	scope: "./",
	display: "standalone",
	orientation: "any",
	// Both follow the design tokens: the action colour for the browser chrome and
	// the page surface for the splash background.
	theme_color: "#6e6e80",
	background_color: "#ffffff",
	icons: [
		// `any` and `maskable` are separate entries on purpose: a combined
		// `any maskable` entry produces a badly cropped icon on platforms that
		// apply a mask.
		{
			src: "./icon-192.png",
			sizes: "192x192",
			type: "image/png",
			purpose: "any",
		},
		{
			src: "./icon-512.png",
			sizes: "512x512",
			type: "image/png",
			purpose: "any",
		},
		{
			src: "./icon-512-maskable.png",
			sizes: "512x512",
			type: "image/png",
			purpose: "maskable",
		},
	],
};

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
		VitePWA({
			registerType: "prompt",
			// The application registers the worker itself, in the shell, so it can
			// gate registration on a secure context and drive the update prompt.
			injectRegister: false,
			// Dev builds do not register a worker: a cached shell would hide code
			// changes while developing.
			devOptions: { enabled: false },
			filename: SERVICE_WORKER_FILENAME,
			manifestFilename: MANIFEST_FILENAME,
			manifest: webAppManifest,
			// The shell must not be pinned: a stale cached shell would keep serving
			// an old build after a deployment.
			workbox: {
				globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
				// SPA navigations fall back to the shell so client routing can take over.
				navigateFallback: `${toViteBase(basePath)}_shell.html`,
				// Only same-origin static assets may be stored. Cross-origin requests —
				// model endpoints and analytics alike — must pass straight through:
				// caching them would create a second copy of data the application
				// promises to keep local or never store.
				navigateFallbackDenylist: [/\/(?:api|assets\/.*\.json)/],
				cleanupOutdatedCaches: true,
				clientsClaim: false,
				skipWaiting: false,
			},
		}),
	],
});
