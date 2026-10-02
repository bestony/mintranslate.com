#!/usr/bin/env node
/**
 * Minimal static file server for verifying the built output the same way a
 * static host serves it.
 *
 * Why this exists: `vite preview` runs the SSR build through a Node middleware,
 * which is a different code path from static hosting and would therefore not
 * prove anything about deployment. This server implements the two rules a
 * static host must be configured with (see docs/deployment.md):
 *
 *   1. If a matching file exists, serve it.
 *   2. Otherwise return the SPA shell, so deep links and refreshes work.
 *
 * It also serves the shell for the directory root and for a sub-path mount, so
 * both deployment shapes can be checked locally.
 *
 * Usage: node scripts/serve-static.mjs [--dir dist] [--base /] [--port 4173]
 */

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const SHELL_FILE = '_shell.html'

const CONTENT_TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.woff2': 'font/woff2',
}

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
const rootDir = resolve(args.dir ?? 'dist')
const port = Number(args.port ?? 4173)
// Normalized to a leading slash with no trailing slash, `/` stays `/`.
const rawBase = args.base ?? '/'
const basePath = rawBase === '/' ? '/' : `/${rawBase.replace(/^\/+|\/+$/g, '')}`

if (!statSync(rootDir, { throwIfNoEntry: false })?.isDirectory()) {
	console.error(`[serve-static] directory not found: ${rootDir}`)
	process.exit(1)
}

/** Map a request path to a file inside the output directory, if one exists. */
function resolveFile(urlPath) {
	// Strip the mount prefix so a sub-path deployment is served from the same
	// directory a root deployment uses.
	let relative = urlPath
	if (basePath !== '/') {
		if (relative !== basePath && !relative.startsWith(`${basePath}/`)) return undefined
		relative = relative.slice(basePath.length)
	}

	// Reject traversal: the normalized path must stay inside the output dir.
	const candidate = normalize(join(rootDir, decodeURIComponent(relative)))
	if (candidate !== rootDir && !candidate.startsWith(rootDir + sep)) return undefined

	for (const path of [candidate, join(candidate, 'index.html')]) {
		if (statSync(path, { throwIfNoEntry: false })?.isFile()) return path
	}

	return undefined
}

function send(res, status, filePath) {
	res.writeHead(status, { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' })
	createReadStream(filePath).pipe(res)
}

createServer((req, res) => {
	const urlPath = (req.url ?? '/').split('?')[0].split('#')[0]

	// Directory mounts end with a slash (`/mintranslate/`), which is the form
	// the SPA shell uses for its asset URLs.
	if (basePath !== '/' && urlPath === basePath.replace(/\/$/, '')) {
		res.writeHead(302, { location: `${basePath}/` })
		res.end()
		return
	}

	const file = resolveFile(urlPath)
	if (file) {
		send(res, 200, file)
		return
	}

	// Rule 2: unmatched paths get the SPA shell, not a 404.
	send(res, 200, join(rootDir, SHELL_FILE))
}).listen(port, () => {
	console.log(`[serve-static] ${rootDir} at http://localhost:${port}${basePath}`)
})
