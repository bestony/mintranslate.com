/**
 * Base path helpers.
 *
 * The deployment base path is provided at build time through `VITE_BASE_PATH`
 * and is the single source of truth for every URL the application builds:
 * the bundler base, the client router base path, the web app manifest and the
 * icons. Keeping one normalizer here prevents the classic mismatch between the
 * bundler base and the router base path.
 */

/** Default when no base path is configured: the site root. */
const ROOT_BASE_PATH = "/";

/**
 * Normalize a configured base path into its canonical form.
 *
 * Canonical form: a leading slash, no trailing slash, and `/` for the root.
 * Accepts `undefined`, `mintranslate`, `/mintranslate` and `/mintranslate/`
 * and returns `/mintranslate` for all of them.
 */
export function normalizeBasePath(value: string | undefined): string {
	const trimmed = (value ?? "").trim();

	if (trimmed === "" || trimmed === ROOT_BASE_PATH) {
		return ROOT_BASE_PATH;
	}

	const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");

	return withoutTrailingSlash === "" ? ROOT_BASE_PATH : withoutTrailingSlash;
}

/**
 * Convert a canonical base path into the form the bundler expects.
 *
 * Vite requires the base to keep its trailing slash, so `/mintranslate`
 * becomes `/mintranslate/`. The bundler derives the client router base path
 * from this value, which is why no second router base path is configured.
 */
export function toViteBase(basePath: string): string {
	return basePath === ROOT_BASE_PATH ? ROOT_BASE_PATH : `${basePath}/`;
}

/**
 * Prefix a root-relative path with the deployment base path.
 *
 * Reads the base path from the bundler instead of taking it as an argument so
 * that browser code cannot drift from the value the build was produced with.
 * Used for assets that are not imported as modules, such as the manifest and
 * the Apple touch icon.
 */
export function withBase(path: string): string {
	const base = normalizeBasePath(import.meta.env.BASE_URL);
	const relativePath = path.replace(/^\/+/, "");

	return base === ROOT_BASE_PATH
		? `/${relativePath}`
		: `${base}/${relativePath}`;
}
