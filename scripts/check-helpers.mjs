#!/usr/bin/env node
/**
 * Self-check for the pure decision helpers used by the application shell.
 *
 * These are the rules in this change that are easy to get subtly wrong and hard
 * to observe: the base path normalizer (a wrong value breaks every asset URL)
 * and the secure-context notice gate (a wrong value either hides a real
 * capability gap or flashes a notice in a working environment).
 *
 * The helpers are imported directly; Node strips the TypeScript types.
 *
 * Run: node scripts/check-helpers.mjs
 */

import assert from 'node:assert/strict'

import {
	normalizeBasePath,
	toViteBase,
} from '../src/lib/base-path.ts'
import { shouldShowInsecureContextNotice } from '../src/lib/secure-context.ts'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

let checks = 0

/**
 * List every file below a directory, recursively.
 *
 * Returns an empty list when the directory does not exist, so a check that runs
 * before the first build reports "nothing found" rather than crashing.
 */
function listFiles(root) {
	let entries
	try {
		entries = readdirSync(root, { withFileTypes: true })
	} catch {
		return []
	}

	const files = []
	for (const entry of entries) {
		const path = join(root, entry.name)
		if (entry.isDirectory()) files.push(...listFiles(path))
		else files.push(path)
	}
	return files
}

// --- base path normalization ------------------------------------------------
const normalizeCases = [
	[undefined, '/'],
	['', '/'],
	['   ', '/'],
	['/', '/'],
	['mintranslate', '/mintranslate'],
	['/mintranslate', '/mintranslate'],
	['/mintranslate/', '/mintranslate'],
	['mintranslate/', '/mintranslate'],
	['/a/b/', '/a/b'],
	['/a/b', '/a/b'],
	['  /x/  ', '/x'],
]

for (const [input, expected] of normalizeCases) {
	assert.equal(
		normalizeBasePath(input),
		expected,
		`normalizeBasePath(${JSON.stringify(input)})`,
	)
	checks += 1
}

// The bundler needs a trailing slash on a non-root base; the client router base
// path is derived from it, which is why no second value is configured anywhere.
assert.equal(toViteBase('/'), '/')
assert.equal(toViteBase('/mintranslate'), '/mintranslate/')
checks += 2

// --- secure-context notice gate --------------------------------------------
// Unresolved (prerender, and the first client render): hidden, so the
// prerendered shell and the first client render match.
assert.equal(shouldShowInsecureContextNotice(undefined), false)
// Secure context (HTTPS, or the localhost exemption): hidden.
assert.equal(shouldShowInsecureContextNotice(true), false)
// Insecure context (plain HTTP on a LAN address): shown.
assert.equal(shouldShowInsecureContextNotice(false), true)
checks += 3



// --- no font files in the build output -------------------------------------
// The design system uses the system font stack, so a font file in the output
// means either a dependency crept back in or a `@font-face` was added. Checked
// here rather than in the worker generator because this is the rule, not the
// pre-cache list.
const FONT_EXTENSIONS = ['.woff', '.woff2', '.ttf', '.otf']
const fontFiles = listFiles(process.argv[2] ?? 'dist').filter((file) =>
	FONT_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension)),
)
assert.deepEqual(
	fontFiles,
	[],
	`build output must contain no font files, found: ${fontFiles.join(', ')}`,
)
checks += 1

console.log(`[check-helpers] OK - ${checks} assertions passed.`)
