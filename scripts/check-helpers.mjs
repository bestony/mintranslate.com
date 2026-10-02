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

let checks = 0

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

console.log(`[check-helpers] OK - ${checks} assertions passed.`)
