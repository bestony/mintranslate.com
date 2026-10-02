/**
 * URL state.
 *
 * The workspace keeps its state in the URL so a link reproduces what the sender
 * saw. Two constraints shape the implementation:
 *
 * - **`replaceState`, never `pushState`.** Typing is continuous; pushing a
 *   history entry per keystroke would make the back button useless.
 * - **Source text is bounded and never published.** The `text` parameter is
 *   dropped beyond a threshold rather than truncated — a truncated link would
 *   translate different text than the sender saw, which is worse than a link
 *   without text. And nothing that leaves the application may carry it, which is
 *   why `stripSensitiveParams` exists here as the single stripping entry point.
 */

/** Query parameter names, as fixed by the PRD. */
export const PARAM_SOURCE_LANG = "sl";
export const PARAM_TARGET_LANG = "tl";
export const PARAM_TEXT = "text";
export const PARAM_MODE = "op";

/**
 * Longest source text written to the URL.
 *
 * Conservative on purpose: URL limits differ across browsers and intermediaries,
 * and a link that silently fails to open is worse than one without the text.
 */
export const MAX_URL_TEXT_LENGTH = 2000;

/** Workspace state carried in the URL. */
export interface WorkspaceUrlState {
	readonly sourceLang?: string;
	readonly targetLang?: string;
	readonly text?: string;
	readonly mode?: string;
}

/**
 * Serialize workspace state into a query string.
 *
 * `text` is omitted (not truncated) when it exceeds the threshold.
 */
export function toQueryString(state: WorkspaceUrlState): string {
	const params = new URLSearchParams();

	if (state.mode !== undefined && state.mode !== "")
		params.set(PARAM_MODE, state.mode);
	if (state.sourceLang !== undefined && state.sourceLang !== "") {
		params.set(PARAM_SOURCE_LANG, state.sourceLang);
	}
	if (state.targetLang !== undefined && state.targetLang !== "") {
		params.set(PARAM_TARGET_LANG, state.targetLang);
	}

	// Length is measured on the raw text, before encoding: encoding expands the
	// value, and the point of the threshold is the final URL length.
	if (
		state.text !== undefined &&
		state.text !== "" &&
		state.text.length <= MAX_URL_TEXT_LENGTH
	) {
		params.set(PARAM_TEXT, state.text);
	}

	return params.toString();
}

/** Parse workspace state out of a query string. */
export function fromQueryString(query: string): WorkspaceUrlState {
	const params = new URLSearchParams(
		query.startsWith("?") ? query.slice(1) : query,
	);

	const sourceLang = params.get(PARAM_SOURCE_LANG) ?? undefined;
	const targetLang = params.get(PARAM_TARGET_LANG) ?? undefined;
	const text = params.get(PARAM_TEXT) ?? undefined;
	const mode = params.get(PARAM_MODE) ?? undefined;

	return {
		...(sourceLang !== undefined && { sourceLang }),
		...(targetLang !== undefined && { targetLang }),
		...(text !== undefined && { text }),
		...(mode !== undefined && { mode }),
	};
}

/** Whether a source text is short enough to be published in the URL. */
export function isTextPublishable(text: string): boolean {
	return text.length <= MAX_URL_TEXT_LENGTH;
}

/** The browser history surface this module needs. Injectable for tests. */
export interface HistoryLike {
	replaceState(data: unknown, unused: string, url?: string | URL | null): void;
	pushState?(data: unknown, unused: string, url?: string | URL | null): void;
}

/** Write workspace state to the current URL. */
export function writeWorkspaceUrl(
	state: WorkspaceUrlState,
	history: HistoryLike = window.history,
	location: { pathname: string; hash: string } = window.location,
): void {
	const query = toQueryString(state);
	const url = `${location.pathname}${query === "" ? "" : `?${query}`}${location.hash}`;

	// `replaceState` only: state changes continuously and must not fill history.
	history.replaceState(null, "", url);
}

/**
 * Remove parameters that must never leave the application.
 *
 * This is the single stripping entry point: reporting and diagnostics call it
 * instead of filtering the URL themselves, so there is one implementation to
 * audit and no path that can forget.
 *
 * The source text is the sensitive part. It is removed as a whole parameter
 * rather than truncated, so no fragment of it can survive.
 */
export function stripSensitiveParams(url: string): string {
	const splitAt = url.indexOf("?");
	if (splitAt === -1) return url;

	const base = url.slice(0, splitAt);
	const rest = url.slice(splitAt + 1);

	// Keep the fragment intact while cleaning only the query.
	const hashAt = rest.indexOf("#");
	const query = hashAt === -1 ? rest : rest.slice(0, hashAt);
	const hash = hashAt === -1 ? "" : rest.slice(hashAt);

	const params = new URLSearchParams(query);
	params.delete(PARAM_TEXT);

	const cleaned = params.toString();
	return `${base}${cleaned === "" ? "" : `?${cleaned}`}${hash}`;
}

/** Parameters that must never be reported anywhere. */
export const SENSITIVE_PARAMS = [PARAM_TEXT] as const;
