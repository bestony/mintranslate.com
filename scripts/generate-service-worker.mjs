#!/usr/bin/env node
/**
 * Generate the service worker after the client build.
 *
 * ## Why this is not done by `vite-plugin-pwa`
 *
 * The plugin generates its worker from its `closeBundle` hook, guarded by
 * `!ctx.viteConfig.build.ssr`. That config is re-assigned on *every*
 * `configResolved` call, and under Vite's environment API this project's build
 * resolves three times — the last being the SSR environment, whose root build
 * config carries `ssr: true`. The guard therefore never passes and the worker is
 * silently never written. (Verified by instrumenting the hook order: all three
 * resolutions complete before any `closeBundle` fires.)
 *
 * Rather than mutate a resolved config owned by another plugin — which risks the
 * shell prerender that the SSR environment is responsible for — this script runs
 * `workbox-build` after the build. It has full control over what gets pre-cached,
 * which is exactly what the offline requirement needs: the lazy provider chunks
 * must be in the cache too, so a user can complete a translation offline against
 * a local or intranet model.
 *
 * ## Caching rules
 *
 * - Only same-origin build output is pre-cached (`globDirectory` is the output
 *   directory, and the glob patterns name local file types).
 * - Cross-origin requests are never cached: `runtimeCaching` is deliberately
 *   empty, so the generated worker only serves what it pre-cached and lets every
 *   other request — model endpoints and analytics alike — go straight to the
 *   network.
 * - The workbox runtime is inlined, so the worker loads nothing from a CDN. That
 *   is what keeps the zero-external-dependency promise intact, and it is the
 *   property the build gate checks for.
 *
 * Usage: node scripts/generate-service-worker.mjs [--dir dist] [--base /]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generateSW, getManifest } from 'workbox-build'

import { normalizeBasePath } from '../src/lib/base-path.ts'

/** Files worth pre-caching: the shell plus every asset the app can load. */
const GLOB_PATTERNS = [
	'**/*.{js,css,html,woff2,png,svg,webmanifest}',
	// The manifest is emitted by the PWA plugin under its own name.
	'manifest.webmanifest',
]

/** Files explicitly kept out of the cache. */
const GLOB_IGNORE = ['**/sw.js', '**/workbox-*.js']

/** Read `--flag value` pairs; unknown flags are ignored. */
function parseArgs(argv) {
	const args = {}
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index]
		if (!token.startsWith('--')) continue
		args[token.slice(2)] = argv[index + 1]
		index += 1
	}
	return args
}


const args = parseArgs(process.argv.slice(2))
const outputDir = resolve(args.dir ?? 'dist')
// Reused rather than reimplemented: the project already normalizes base paths in
// one place (with its own tests), and a second copy here would drift — it already
// did once, producing a doubled slash in the navigation fallback.
const basePath = normalizeBasePath(args.base ?? process.env.VITE_BASE_PATH)
const swDest = join(outputDir, 'sw.js')
/** The shell is what a navigation falls back to when offline. */
const navigationFallback = join(outputDir, '_shell.html')

if (!statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()) {
	console.error(`[generate-service-worker] output directory not found: ${outputDir}`)
	process.exit(1)
}

if (!statSync(navigationFallback, { throwIfNoEntry: false })?.isFile()) {
	console.error(
		`[generate-service-worker] shell not found: ${navigationFallback} (the SPA shell is the offline fallback)`,
	)
	process.exit(1)
}

const result = await generateSW({
	globDirectory: outputDir,
	globPatterns: GLOB_PATTERNS,
	globIgnores: GLOB_IGNORE,
	swDest,
	// A navigation must resolve to the shell so client routing takes over. The path
	// carries the deployment base so a sub-path build points at its own shell.
	navigateFallback: `${basePath === '/' ? '' : basePath}/_shell.html`,
	// Inline the runtime: no separate workbox chunk and, more importantly, no
	// `importScripts` of any kind.
	inlineWorkboxRuntime: true,
	// Drop caches from older builds so a deployment does not accumulate them.
	cleanupOutdatedCaches: true,
	// The new worker waits for the page to ask for it. `skipWaiting` would let it
	// take over while the user is mid-translation, which the update flow forbids.
	skipWaiting: false,
	clientsClaim: false,
	// No runtime caching at all. This is the mechanism behind "model requests and
	// analytics are never cached": there is no rule that could store them, and the
	// absence of rules is easier to audit than a list of exclusions.
	runtimeCaching: [],
})

// The pre-cache manifest is computed with the library's own glob logic (rather
// than re-implemented here), so the reported contents are exactly what the worker
// was given. An entry carries a revision but no size, so sizes come from the
// files themselves.
const { manifestEntries } = await getManifest({
	globDirectory: outputDir,
	globPatterns: GLOB_PATTERNS,
	globIgnores: GLOB_IGNORE,
})

/** On-disk size of a pre-cached URL. */
function sizeOf(url) {
	const stats = statSync(join(outputDir, url), { throwIfNoEntry: false })
	return stats?.isFile() === true ? stats.size : 0
}

const totalBytes = manifestEntries.reduce((sum, entry) => sum + sizeOf(entry.url), 0)

// Chunks the shell loads eagerly versus chunks fetched on demand. The on-demand
// ones are what make offline translation possible (the provider adapters), so
// their presence in the cache is reported explicitly rather than assumed.
const shellHtml = readFileSync(join(outputDir, '_shell.html'), 'utf8')
/** Strip the deployment base prefix so shell references match manifest URLs. */
function toManifestUrl(reference) {
	const withoutBase =
		basePath !== '/' && reference.startsWith(`${basePath}/`)
			? reference.slice(basePath.length + 1)
			: reference
	return withoutBase.replace(/^\/+/, '')
}

const eagerScripts = new Set(
	[...shellHtml.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => toManifestUrl(match[1])),
)
const cachedScripts = manifestEntries.filter((entry) => entry.url.endsWith('.js'))
const onDemandScripts = cachedScripts.filter((entry) => !eagerScripts.has(entry.url))

console.log(
	`[generate-service-worker] ${manifestEntries.length} file(s) pre-cached, ` +
		`${(totalBytes / 1024 / 1024).toFixed(2)} MB total, ` +
		`${cachedScripts.length} script(s) of which ${onDemandScripts.length} load on demand`,
)
// Recorded so the "offline complete vs. background download size" trade-off stays
// visible, and so a regression in what gets included is noticeable.
console.log(
	`[generate-service-worker] on-demand scripts cached: ${onDemandScripts.map((entry) => entry.url).join(', ') || 'none'}`,
)

/** Report anything in the output directory that no pattern matched. */
function collectUnmatched(directory, prefix = '') {
	const unmatched = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const url = prefix === '' ? entry.name : `${prefix}/${entry.name}`
		if (entry.isDirectory()) {
			unmatched.push(...collectUnmatched(join(directory, entry.name), url))
			continue
		}
		if (url === 'sw.js' || url.startsWith('workbox-') || url.endsWith('.map')) continue
		if (!manifestEntries.some((item) => item.url === url)) unmatched.push(url)
	}
	return unmatched
}

const unmatched = collectUnmatched(outputDir)
if (unmatched.length > 0) {
	// Not fatal — some output is intentionally not cached — but silence would read
	// as "everything is cached", so it is reported.
	console.log(`[generate-service-worker] not pre-cached: ${unmatched.join(', ')}`)
}
