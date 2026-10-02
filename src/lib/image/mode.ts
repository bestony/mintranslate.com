/**
 * Workspace mode value.
 *
 * The mode travels in the URL's `op` parameter, which is a free string in the
 * url-state module. Two things constrain the value:
 *
 * - it must be one the analytics contract already recognises, so an image run is
 *   attributed to images rather than falling back to text;
 * - an unrecognised value must degrade to text mode rather than leaving the
 *   workspace in a state it cannot render.
 */

/** Modes the translation workspace offers. */
export const WORKSPACE_MODES = ["text", "images"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/** Value written to the URL for each mode. */
export const MODE_URL_VALUES: Record<WorkspaceMode, string> = {
	text: "translate",
	images: "images",
};

/**
 * Resolve a URL `op` value to a workspace mode.
 *
 * Only `images` selects image mode. Everything else — including the legacy
 * `translate` value, an empty string, or anything unrecognised — is text mode,
 * which is the only safe default: the text workspace always works, and an unknown
 * mode has no interface to show.
 */
export function modeFromUrl(value: string | undefined): WorkspaceMode {
	return value === MODE_URL_VALUES.images ? "images" : "text";
}

/** The URL value for a mode. */
export function urlValueForMode(mode: WorkspaceMode): string {
	return MODE_URL_VALUES[mode];
}
