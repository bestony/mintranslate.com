/**
 * Secondary search.
 *
 * Turns the translation into a search query so the user can look the result up
 * in context. Only the query travels: no source text, no model identity, no
 * endpoint, no history id — a search URL ends up in the browser's history and
 * possibly the search provider's logs.
 */

/** Search engines offered. Kept as data so the list is auditable at a glance. */
export const SEARCH_ENGINES = [
	{
		id: "google",
		label: "Google",
		build: (query: string) => `https://www.google.com/search?q=${query}`,
	},
	{
		id: "bing",
		label: "Bing",
		build: (query: string) => `https://www.bing.com/search?q=${query}`,
	},
	{
		id: "duckduckgo",
		label: "DuckDuckGo",
		build: (query: string) => `https://duckduckgo.com/?q=${query}`,
	},
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINES)[number]["id"];

/** Default engine when the user has not chosen one. */
export const DEFAULT_SEARCH_ENGINE: SearchEngineId = "google";

/**
 * Normalize a translation into a search query.
 *
 * Newlines become spaces rather than being dropped: a multi-paragraph
 * translation must not be silently narrowed to its first line.
 */
export function toSearchQuery(text: string): string {
	return text
		.replace(/\s*\n+\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * Build a search URL for a translation.
 *
 * Returns `undefined` for empty input so callers can keep the entry point
 * disabled instead of issuing a blank query.
 */
export function buildSearchUrl(
	text: string,
	engine: SearchEngineId = DEFAULT_SEARCH_ENGINE,
): string | undefined {
	const query = toSearchQuery(text);
	if (query === "") return undefined;

	const chosen =
		SEARCH_ENGINES.find((entry) => entry.id === engine) ?? SEARCH_ENGINES[0];
	// `encodeURIComponent` escapes `&` and `#`, which would otherwise end the query
	// early and change what is searched for.
	return chosen.build(encodeURIComponent(query));
}

/** Whether a search can be offered for this text. */
export function canSearch(text: string): boolean {
	return toSearchQuery(text) !== "";
}

/** How a new tab is opened. Injectable so the call is assertable without a DOM. */
export type OpenInNewTab = (
	url: string,
	target: string,
	features: string,
) => unknown;

/**
 * Open a search URL in a new tab.
 *
 * `noopener` prevents the opened page from reaching back through
 * `window.opener`, and `noreferrer` keeps the app's own URL out of the referrer.
 */
export function openSearchUrl(url: string, openInNewTab: OpenInNewTab): void {
	openInNewTab(url, "_blank", "noopener,noreferrer");
}

/**
 * Open a search for the given text.
 *
 * Resolves the URL here so the caller does not have to check for an empty query
 * itself; returns whether a tab was opened.
 */
export function searchText(
	text: string,
	engine: SearchEngineId,
	openInNewTab: OpenInNewTab,
): boolean {
	const url = buildSearchUrl(text, engine);
	if (url === undefined) return false;

	openSearchUrl(url, openInNewTab);
	return true;
}
