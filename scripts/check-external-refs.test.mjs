#!/usr/bin/env node
/**
 * Self-check for scripts/check-external-refs.mjs.
 *
 * The gate decides whether a build ships. Its rules are easy to break subtly —
 * a loosened pattern stops catching a real CDN reference, a broadened one
 * fails every build. Each of the five resource-reference forms gets a negative
 * case, and the bare-URL downgrade gets a positive case proving it does not
 * affect the exit code.
 *
 * Fixtures are written to a temp directory and the real script is executed as a
 * subprocess, so this exercises the shipped code path rather than a copy.
 *
 * Run: node scripts/check-external-refs.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const CHECKER = new URL('./check-external-refs.mjs', import.meta.url).pathname

let checks = 0
const workspace = mkdtempSync(join(tmpdir(), 'minrefs-'))

/** Write a fixture tree and run the checker against it. */
function runChecker(files, env = {}) {
	const dir = mkdtempSync(join(workspace, 'case-'))

	for (const [name, contents] of Object.entries(files)) {
		const fullPath = join(dir, name)
		mkdirSync(join(fullPath, '..'), { recursive: true })
		writeFileSync(fullPath, contents, 'utf8')
	}

	let exitCode = 0
	let stdout = ''
	try {
		// Start from a controlled environment: the analytics variables decide whether
		// the gate allows the analytics origin, so inheriting them from the shell would
		// make these assertions depend on how the developer's session happens to be set
		// up. A case opts in by passing them explicitly.
		const baseEnv = { ...process.env }
		delete baseEnv.VITE_GA_MEASUREMENT_ID
		delete baseEnv.VITE_GA_ENABLED

		stdout = execFileSync('node', [CHECKER, dir], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...baseEnv, ...env },
		})
	} catch (error) {
		exitCode = error.status ?? 1
		stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`
	}

	return { exitCode, stdout }
}

/** Each entry: a resource reference that MUST fail the build. */
const mustFail = [
	{
		label: 'script src',
		files: { 'index.html': '<script src="https://cdn.example.com/a.js"></script>' },
		host: 'cdn.example.com',
	},
	{
		label: 'link href',
		files: { 'index.html': '<link href="https://fonts.example.com/a.css" rel="stylesheet">' },
		host: 'fonts.example.com',
	},
	{
		label: 'css url()',
		files: { 'assets/a.css': 'body{background:url(https://cdn.example.com/i.png)}' },
		host: 'cdn.example.com',
	},
	{
		label: 'css @import',
		files: { 'assets/a.css': '@import "https://cdn.example.com/theme.css";' },
		host: 'cdn.example.com',
	},
	{
		label: 'remote import()',
		files: { 'assets/a.js': 'const m = import("https://cdn.example.com/m.js")' },
		host: 'cdn.example.com',
	},
	{
		label: 'remote Worker',
		files: { 'assets/a.js': 'new Worker("https://cdn.example.com/w.js")' },
		host: 'cdn.example.com',
	},
	{
		label: 'remote SharedWorker',
		files: { 'assets/a.js': 'new SharedWorker("https://cdn.example.com/sw.js")' },
		host: 'cdn.example.com',
	},
	{
		label: 'protocol-relative link href',
		files: { 'index.html': '<link href="//cdn.example.com/a.css" rel="stylesheet">' },
		host: 'cdn.example.com',
	},
	{
		label: 'worker importScripts()',
		files: { 'sw.js': 'importScripts("https://cdn.example.com/workbox.js")' },
		host: 'cdn.example.com',
	},
	{
		label: 'worker importScripts() with single quotes',
		files: { 'sw.js': "importScripts('https://cdn.example.com/workbox.js')" },
		host: 'cdn.example.com',
	},
]

for (const testCase of mustFail) {
	const { exitCode, stdout } = runChecker(testCase.files)
	assert.equal(exitCode, 1, `${testCase.label} must fail the build`)
	assert.ok(
		stdout.includes(testCase.host),
		`${testCase.label} must name the offending host (${testCase.host})`,
	)
	checks += 1
}

// --- bare URLs are reported, never fatal ------------------------------------
{
	const { exitCode, stdout } = runChecker({
		'assets/a.js':
			'const docs=["https://docs.example.com/a","https://docs.example.com/b","https://docs.example.com/c"]',
	})
	assert.equal(exitCode, 0, 'bare URL strings must not fail the build')
	assert.ok(
		/docs\.example\.com\s+x3\b/.test(stdout),
		'bare URLs must be aggregated per host with a count (expected "docs.example.com  x3")',
	)
	checks += 2
}

// --- mixed: a reference must still fail even when bare URLs are present -----
{
	const { exitCode, stdout } = runChecker({
		'assets/a.js':
			'const d="https://docs.example.com/x"; new Worker("https://cdn.example.com/w.js")',
	})
	assert.equal(exitCode, 1, 'a resource reference must fail even alongside bare URLs')
	assert.ok(stdout.includes('cdn.example.com'), 'the failing reference must be reported')
	checks += 2
}

// --- same-origin and local references pass ----------------------------------
{
	const { exitCode } = runChecker({
		'index.html':
			'<link href="/assets/a.css" rel="stylesheet"><script src="/assets/a.js"></script>',
		'assets/a.css': 'body{background:url(/assets/i.png)}',
		'assets/a.js': 'const u="http://localhost:3000/x"; const w="http://127.0.0.1:1/y"',
	})
	assert.equal(exitCode, 0, 'same-origin and loopback references must pass')
	checks += 1
}

// --- mentioning importScripts is not a load ---------------------------------
{
	const { exitCode, stdout } = runChecker({
		// A comment explains that the runtime is bundled and cites the project docs.
		// The identifier appears and a remote URL appears, but neither is a load.
		// Matching on the bare word — or on "the identifier followed somewhere by a
		// URL" — would fail this build for a comment.
		"sw.js":
			"// We do not call importScripts; the runtime is bundled locally.\n" +
			"// See https://workboxjs.org/docs for background.\n" +
			'self.addEventListener("install", () => {})',
	})
	assert.equal(exitCode, 0, "a bare mention of importScripts must not fail the build")
	// The documentation URL is still reported for human review, just not fatal.
	assert.ok(stdout.includes("workboxjs.org"), "the doc URL should appear in the report")
	checks += 2
}

// --- non-http schemes are not network resource references -------------------
{
	const { exitCode } = runChecker({
		'index.html': '<link href="data:text/css,body%7B%7D" rel="stylesheet">',
		'assets/a.js': 'const m = import("data:text/javascript,export default 1")',
	})
	assert.equal(exitCode, 0, 'data: URLs must not be treated as external resource references')
	checks += 1
}

// --- analytics endpoints stay gated on build configuration ------------------
{
	const gaFixture = {
		'index.html': '<script src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>',
	}

	assert.equal(runChecker(gaFixture).exitCode, 1, 'analytics must fail without a measurement ID')
	assert.equal(
		runChecker(gaFixture, { VITE_GA_MEASUREMENT_ID: 'G-ABC' }).exitCode,
		0,
		'analytics must pass with a measurement ID',
	)
	assert.equal(
		runChecker(gaFixture, { VITE_GA_MEASUREMENT_ID: 'G-ABC', VITE_GA_ENABLED: 'false' }).exitCode,
		1,
		'the build-time analytics master switch must override a measurement ID',
	)
	checks += 3
}

rmSync(workspace, { recursive: true, force: true })

console.log(`[check-external-refs.test] OK - ${checks} assertions passed.`)
