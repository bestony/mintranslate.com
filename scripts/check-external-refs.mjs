#!/usr/bin/env node
/**
 * Build output self-check: fail the build if the static output contains a
 * **resource reference** to an external origin.
 *
 * Why this exists: the application must load with zero external network access,
 * so every font, icon, script and stylesheet has to be served from the same
 * origin as the application. A stray CDN reference degrades silently in a
 * browser (fallback font, missing icon) which is exactly the failure this
 * repository must not ship.
 *
 * Two categories, deliberately treated differently (spec `build-self-check`,
 * design.md D6):
 *
 * 1. **Resource references** — the browser will fetch these. `<script src>`,
 *    `<link href>`, CSS `url()` / `@import`, remote `import()`, and a Worker
 *    constructed from a remote URL. Any of these pointing off-origin breaks the
 *    zero-external-network promise, so they FAIL the build.
 *
 * 2. **Bare URL strings** — documentation links, help addresses and default
 *    endpoint constants that ship inside third-party SDKs. Nothing fetches
 *    them. Failing on these made it impossible to depend on any official
 *    provider SDK, so they are reported instead: aggregated per host, printed
 *    for human review, and they do NOT affect the exit code.
 *
 * The distinction matters because a bare URL string cannot cause an outbound
 * request, while a resource reference always can.
 *
 * Design notes:
 * - The check runs against build output, not source. Bundler-injected
 *   references and files copied verbatim from the static directory are both
 *   only visible in the output.
 * - On the resource-reference side the strategy stays "no false negatives over
 *   false positives": a match fails the build and a human decides.
 * - No network access: the scan is pure string matching, so it also works in an
 *   air-gapped intranet build.
 *
 * Usage: node scripts/check-external-refs.mjs [outputDir]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** Directory scanned when no argument is given. */
const DEFAULT_OUTPUT_DIR = 'dist'

/** File extensions worth scanning: everything that can carry a reference. */
const SCANNABLE_EXTENSIONS = ['.html', '.css', '.js', '.mjs', '.json', '.webmanifest']

/**
 * Origins that are legitimate even as a resource reference.
 *
 * Entry forms, from narrowest to broadest:
 * - `host/path`      exact path match only
 * - `host/path/`     that path prefix and everything under it
 * - `host/`          any path on that host
 * - `host`           that host with no path at all
 *
 * There is deliberately no way to spell "bare host allows any path": an entry
 * for `example.com` will not permit `example.com/script.js`. Write `example.com/`
 * to mean every path on the host, so the intent is explicit at the call site.
 *
 * Keep this list as short as possible. Since bare URL strings are now only
 * reported, most former entries are no longer needed here at all — they were
 * documentation links, which the reporting path covers.
 */
const ALLOWED_RESOURCE_ORIGINS = [
	// XML namespace identifiers used by inlined SVG and MathML markup. These
	// name a vocabulary; they are never fetched. Listed because a namespace
	// declaration looks like a URL to a string scan.
	'www.w3.org/1998/',
	'www.w3.org/1999/',
	'www.w3.org/2000/',
	'www.w3.org/XML/',
]

/**
 * Analytics endpoints.
 *
 * Allowed only when analytics was configured for this build, because the
 * analytics change (analytics-ga4) is what introduces those requests. Without
 * a measurement ID the application must ship no reference to them at all, so
 * an unconditional allowlist entry would hide a real regression.
 */
const ANALYTICS_ORIGINS = ['googletagmanager.com/', 'google-analytics.com/']

/**
 * Whether this build was configured with analytics.
 *
 * Both switches must agree for analytics endpoints to be acceptable: the
 * measurement ID supplies the target and `VITE_GA_ENABLED` is the master
 * switch the intranet build turns off. Keeping the allowlist bound to the same
 * pair of variables the analytics change reads means the check can never
 * approve an endpoint that the build was not configured to use.
 */
function analyticsConfigured() {
	if (process.env.VITE_GA_ENABLED?.trim().toLowerCase() === 'false') return false
	return Boolean(process.env.VITE_GA_MEASUREMENT_ID?.trim())
}

/**
 * Any absolute or protocol-relative URL, with its path.
 *
 * Used as the low-level token both detectors build on. The path is captured so
 * allowlist entries can be narrowed to a prefix instead of a whole host.
 */
const URL_PATTERN =
	/(?:[a-zA-Z][a-zA-Z\d+.-]*:)?\/\/[a-zA-Z\d.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:\/[\w\-.~%!$&'()*+,;=:@/]*)?/g

/**
 * The five resource-reference forms, each anchored on the syntax that makes the
 * browser load something. See the module header for why only these fail.
 *
 * `[^"'`)\s]` is used for URL characters so the patterns cannot run past the end
 * of a quoted attribute or a `url(...)` argument.
 */
const RESOURCE_REFERENCE_PATTERNS = [
	{
		// <script src="..."> — script element, any quoting, attribute order
		// irrelevant because we match the src attribute following `<script`.
		name: 'script src',
		pattern:
			/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[\s>]/gi,
	},
	{
		// <link href="..."> — stylesheets, icons, manifests, preloads.
		name: 'link href',
		pattern: /<link\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[\s/>]/gi,
	},
	{
		// CSS url(...) — fonts, images, and any other stylesheet-relative asset.
		name: 'css url()',
		pattern: /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi,
	},
	{
		// CSS @import "..." / @import url(...) — a remote stylesheet.
		name: 'css @import',
		pattern: /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi,
	},
	{
		// Remote dynamic import: import("https://...") or import('//...').
		// Static `import ... from "./x"` never carries a remote URL in output,
		// and a relative specifier is filtered out by the external-URL check.
		name: 'remote import()',
		pattern: /\bimport\s*\(\s*(?:"([^"]*)"|'([^']*)')/gi,
	},
	{
		// Worker constructed from a remote URL: new Worker("https://...").
		name: 'remote Worker',
		pattern: /\bnew\s+(?:Shared)?Worker\s*\(\s*(?:"([^"]*)"|'([^']*)')/gi,
	},
	{
		// importScripts("https://...") inside a worker.
		//
		// This is a separate entry because the load does not pass through the page:
		// a worker can pull a script from any origin, and nothing on the page side
		// observes it. Service workers make this reachable in practice — the common
		// Workbox setup fetches its runtime from a CDN this way — and a build that did
		// so would break the zero-external-dependency promise in exactly the
		// environment (an intranet with no internet) that promise exists for.
		//
		// Anchored on the call syntax rather than the bare identifier so that a
		// documentation string mentioning it is not mistaken for a load.
		name: 'worker importScripts()',
		pattern: /\bimportScripts\s*\(\s*(?:"([^"]*)"|'([^']*)')/gi,
	},
]

/** Local origins that never resolve to a third party. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1']

/** Recursively collect files under `dir` whose extension is scannable. */
function collectFiles(dir) {
	const found = []

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name)

		if (entry.isDirectory()) {
			found.push(...collectFiles(fullPath))
			continue
		}

		if (entry.isFile() && SCANNABLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
			found.push(fullPath)
		}
	}

	return found
}

/** Extract the full host plus path from a matched URL-ish string. */
function hostAndPathOf(match) {
	const withoutScheme = match.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:/, '')
	return withoutScheme.slice(2)
}

/**
 * Whether `hostAndPath` is allowed by an entry.
 *
 * See ALLOWED_RESOURCE_ORIGINS for the four entry forms.
 */
function allows(hostAndPath, entry) {
	const slashIndex = entry.indexOf('/')
	const entryHost = slashIndex === -1 ? entry : entry.slice(0, slashIndex)

	const hostname = hostAndPath.split(/[:/]/, 1)[0]
	const hostMatches = hostname === entryHost || hostname.endsWith(`.${entryHost}`)
	if (!hostMatches) return false

	const path = hostAndPath.slice(hostname.length).replace(/^\/+/, '')

	// `host` - no path at all is allowed.
	if (slashIndex === -1) return path === ''

	const entryPath = entry.slice(slashIndex + 1)

	// `host/` - any path on the host.
	if (entryPath === '') return true

	// `host/path/` - path prefix; `host/path` - exact path.
	return entry.endsWith('/') ? path.startsWith(entryPath) : path === entryPath
}

/**
 * Whether a captured URL is an external origin the check should care about.
 *
 * Returns the host when external, or `undefined` for same-origin/relative URLs,
 * local hosts, and in-page fragments.
 */
function externalHostOf(url, allowedOrigins) {
	const trimmed = url.trim()
	if (trimmed === '') return undefined

	// Relative references (including root-relative and protocol-relative-less
	// paths) are same-origin by definition.
	if (!/^(?:[a-zA-Z][a-zA-Z\d+.-]*:)?\/\//.test(trimmed)) return undefined

	// Schemes other than http(s) are not network resource references. Data and
	// blob URLs are self-contained; mailto and tel are not loaded as resources.
	const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/)
	if (schemeMatch) {
		const scheme = schemeMatch[1].toLowerCase()
		if (scheme !== 'http' && scheme !== 'https') return undefined
	}

	const hostAndPath = hostAndPathOf(trimmed)
	const hostname = hostAndPath.split(/[:/]/, 1)[0]

	if (LOCAL_HOSTS.includes(hostname)) return undefined
	if (allowedOrigins.some((entry) => allows(hostAndPath, entry))) return undefined

	return hostname
}

/**
 * Find resource references to external origins in one file.
 *
 * These are the failures.
 */
function findResourceReferences(source, allowedOrigins) {
	const found = []

	for (const { name, pattern } of RESOURCE_REFERENCE_PATTERNS) {
		pattern.lastIndex = 0

		for (const match of source.matchAll(pattern)) {
			const url = match[1] ?? match[2] ?? match[3] ?? ''
			const host = externalHostOf(url, allowedOrigins)
			if (!host) continue

			found.push({
				kind: name,
				host,
				url: url.trim(),
				index: match.index ?? 0,
			})
		}
	}

	return found
}

/**
 * Find bare URL strings to external origins in one file.
 *
 * These are reported, never fatal. A resource reference also contains a bare
 * URL, so callers subtract the reference spans first to avoid double counting.
 */
function findBareUrls(source, allowedOrigins, coveredSpans) {
	const found = []

	URL_PATTERN.lastIndex = 0
	for (const match of source.matchAll(URL_PATTERN)) {
		const index = match.index ?? 0
		const end = index + match[0].length

		// Skip URLs already accounted for as a resource reference.
		if (coveredSpans.some((span) => index >= span.start && index < span.end)) continue

		const host = externalHostOf(match[0], allowedOrigins)
		if (!host) continue

		found.push({ host, url: match[0] })
	}

	return found
}

/** Zero-based offset of a source index within its file, plus line number. */
function locate(source, index) {
	const before = source.slice(0, index)
	const line = before.split('\n').length
	return line
}

function main() {
	const outputDir = resolve(process.argv[2] ?? DEFAULT_OUTPUT_DIR)

	if (!statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()) {
		console.error(`[verify:no-external-refs] output directory not found: ${outputDir}`)
		process.exit(1)
	}

	const allowedOrigins = [
		...ALLOWED_RESOURCE_ORIGINS,
		...(analyticsConfigured() ? ANALYTICS_ORIGINS : []),
	]

	const files = collectFiles(outputDir)
	const failures = []
	const reports = []

	for (const file of files) {
		const source = readFileSync(file, 'utf8')
		const relativePath = relative(outputDir, file).split(sep).join('/')

		const references = findResourceReferences(source, allowedOrigins)
		for (const reference of references) {
			failures.push({
				file: relativePath,
				line: locate(source, reference.index),
				kind: reference.kind,
				url: reference.url,
				snippet:
					source.slice(Math.max(0, reference.index - 40), reference.index + 120).trim(),
			})
		}

		// Resource references already fail the build; still report the other
		// bare URLs so a single run shows the whole picture.
		const coveredSpans = references.map((reference) => ({
			start: reference.index,
			end: reference.index + reference.url.length,
		}))

		for (const bare of findBareUrls(source, allowedOrigins, coveredSpans)) {
			reports.push({ file: relativePath, ...bare })
		}
	}

	// --- bare URL report (never fatal) --------------------------------------
	if (reports.length > 0) {
		const byHost = new Map()
		for (const report of reports) {
			const entry = byHost.get(report.host) ?? { count: 0, files: new Set() }
			entry.count += 1
			entry.files.add(report.file)
			byHost.set(report.host, entry)
		}

		const ordered = [...byHost.entries()].sort((a, b) => b[1].count - a[1].count)

		console.log(
			`[verify:no-external-refs] Bare URL strings (not fetched, informational): ${reports.length} occurrence(s) across ${byHost.size} host(s)`,
		)
		for (const [host, entry] of ordered) {
			const fileList = [...entry.files].sort().join(', ')
			console.log(`  ${host}  x${entry.count}  (${fileList})`)
		}
	}

	// --- resource references (fatal) ---------------------------------------
	if (failures.length === 0) {
		console.log(
			`[verify:no-external-refs] OK - ${files.length} file(s) scanned, no external resource references.`,
		)
		return
	}

	console.error(
		`\n[verify:no-external-refs] FAIL - ${failures.length} external resource reference(s) found in ${outputDir}:\n`,
	)
	for (const failure of failures) {
		console.error(`  ${failure.file}:${failure.line}  [${failure.kind}]  ->  ${failure.url}`)
		console.error(`      ${failure.snippet}`)
	}
	console.error(
		'\nSelf-host the asset, or add the origin to ALLOWED_RESOURCE_ORIGINS in scripts/check-external-refs.mjs with a comment explaining why it is legitimate.',
	)
	process.exit(1)
}

main()
