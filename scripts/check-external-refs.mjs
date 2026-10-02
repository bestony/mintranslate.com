#!/usr/bin/env node
/**
 * Build output self-check: fail the build if the static output references any
 * external origin.
 *
 * Why this exists (design.md D4): the application must load with zero external
 * network access, so every font, icon, script and stylesheet has to be served
 * from the same origin as the application. A stray CDN reference degrades
 * silently in a browser (fallback font, missing icon) which is exactly the
 * failure this repository must not ship.
 *
 * Design notes:
 * - The check runs against build output, not source. Bundler-injected
 *   references and files copied verbatim from the static directory are both
 *   only visible in the output.
 * - Strategy is "no false negatives over false positives" (design.md D4).
 *   A match fails the build and a human decides; an explicit allowlist holds
 *   the references that are legitimate.
 * - No network access: the scan is pure string matching, so it also works in
 *   an air-gapped intranet build.
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
 * Origins that are always legitimate to reference.
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
 */
const ALWAYS_ALLOWED_ORIGINS = [
	// XML namespace identifiers. These name a vocabulary, they are never
	// fetched. React writes them into inlined SVG and MathML markup.
	'www.w3.org/1998/',
	'www.w3.org/1999/',
	'www.w3.org/2000/',
	'www.w3.org/XML/',
	// React error documentation links, built at runtime as
	// `https://react.dev/errors/<code>`. They appear only inside thrown error
	// messages; nothing is fetched.
	'react.dev/errors/',
	// The Tailwind CSS license banner at the top of the compiled stylesheet.
	// A comment naming the project home page, not a reference.
	'tailwindcss.com',
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
 * Absolute URLs and protocol-relative URLs, including their path.
 *
 * The path is captured so allowlist entries can be narrowed to a prefix
 * (`react.dev/errors/`) instead of whitelisting an entire host.
 * Matching is intentionally broad: any `//host` sequence is treated as a
 * possible remote reference. Over-matching is acceptable, under-matching is not.
 */
const URL_PATTERN =
	/(?:[a-zA-Z][a-zA-Z\d+.-]*:)?\/\/[a-zA-Z\d.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:\/[\w\-.~%!$&'()*+,;=:@/]*)?/g

/**
 * Local origins that are not external references.
 *
 * Loopback hosts appear in development tooling strings and in documentation
 * baked into the bundle; they never resolve to a third party.
 */
const LOCAL_ORIGINS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']

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
 * See ALWAYS_ALLOWED_ORIGINS for the three entry forms. A bare host entry
 * matches only that host with no path, so it can never authorise a real asset
 * reference under the same host.
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

/** Collect every violating reference in one file. */
function findViolationsInFile(filePath, allowedOrigins) {
	const violations = []
	const lines = readFileSync(filePath, 'utf8').split('\n')

	for (const [index, line] of lines.entries()) {
		for (const match of line.match(URL_PATTERN) ?? []) {
			const hostAndPath = hostAndPathOf(match)
			const hostname = hostAndPath.split(/[:/]/, 1)[0]

			if (LOCAL_ORIGINS.includes(hostname)) continue
			if (allowedOrigins.some((entry) => allows(hostAndPath, entry))) continue

			violations.push({
				hostname,
				url: match,
				line: index + 1,
				snippet: line.trim().slice(0, 160),
			})
		}
	}

	return violations
}

function main() {
	const outputDir = resolve(process.argv[2] ?? DEFAULT_OUTPUT_DIR)

	if (!statSync(outputDir, { throwIfNoEntry: false })?.isDirectory()) {
		console.error(`[verify:no-external-refs] output directory not found: ${outputDir}`)
		process.exit(1)
	}

	const allowedOrigins = [
		...ALWAYS_ALLOWED_ORIGINS,
		...(analyticsConfigured() ? ANALYTICS_ORIGINS : []),
	]

	const files = collectFiles(outputDir)
	const failures = []

	for (const file of files) {
		for (const violation of findViolationsInFile(file, allowedOrigins)) {
			failures.push({ file: relative(outputDir, file).split(sep).join('/'), ...violation })
		}
	}

	if (failures.length === 0) {
		console.log(
			`[verify:no-external-refs] OK - ${files.length} file(s) scanned, no external references.`,
		)
		return
	}

	console.error(
		`[verify:no-external-refs] FAIL - ${failures.length} external reference(s) found in ${outputDir}:\n`,
	)
	for (const failure of failures) {
		console.error(`  ${failure.file}:${failure.line}  ->  ${failure.url}`)
		console.error(`      ${failure.snippet}`)
	}
	console.error(
		'\nSelf-host the asset, or add the origin to an allowlist in scripts/check-external-refs.mjs with a comment explaining why it is legitimate.',
	)
	process.exit(1)
}

main()
