import { defineConfig } from 'vitest/config'

/**
 * Unit-test configuration, deliberately separate from `vite.config.ts`.
 *
 * The application config loads the TanStack Start plugins, which assume a full
 * app build and cannot serve as a test environment. Unit tests here cover pure
 * logic only — normalizers, attribution, redaction, tier derivation, storage
 * serialization — so no application plugins and no DOM environment are needed.
 *
 * `include` is scoped to `src/` because the scripts under `scripts/` are
 * standalone Node programs with their own assertion harnesses (run via
 * `pnpm verify`), not vitest suites.
 */
export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
		reporters: ['default'],
		// A missing suite is an error, not a silent pass. Set to false again
		// once the first suite exists so an accidental rename is caught.
		passWithNoTests: true,
	},
})
