import { defineConfig } from 'vitest/config'

/**
 * Unit-test configuration, deliberately separate from `vite.config.ts`.
 *
 * The application config loads the TanStack Start plugins, which assume a full
 * app build and cannot serve as a test environment. Unit tests here cover pure
 * logic — normalizers, attribution, redaction, tier derivation, storage
 * serialization — so no application plugins are needed.
 *
 * Most suites are pure and run in `node`. A few hydrating-render suites need a DOM
 * and opt in per-file with a `@vitest-environment jsdom` docblock; the default
 * stays `node` so a pure suite cannot accidentally start depending on browser
 * globals.
 *
 * `include` is scoped to `src/` because the scripts under `scripts/` are
 * standalone Node programs with their own assertion harnesses (run via
 * `pnpm verify`), not vitest suites.
 */
export default defineConfig({
	// JSX in test files uses the automatic runtime, matching the application's
	// tsconfig. Vite 8 transforms with oxc, so the option belongs there.
	oxc: { jsx: { runtime: 'automatic' } },
	test: {
		include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
		environment: 'node',
		reporters: ['default'],
		// A missing suite is an error, not a silent pass. Set to false again
		// once the first suite exists so an accidental rename is caught.
		passWithNoTests: true,
	},
})
