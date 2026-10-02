/**
 * Share link and outbound share targets.
 *
 * Two things this module deliberately does not do:
 *
 * - It does not build URLs itself. The workspace already defines the parameter
 *   names, the encoding and the length threshold in `src/lib/url-state`; a second
 *   implementation would drift, and the threshold would end up with two sources
 *   of truth.
 * - It does not decide *how* to share. It returns the data for each channel, so
 *   the decision (system sheet vs. built-in options) is testable without a
 *   browser.
 *
 * Sharing deliberately omits the full endpoint, model id and any credential: a
 * link is public by nature, so it carries only what reproduces the translation.
 */

import {
	isTextPublishable,
	MAX_URL_TEXT_LENGTH,
	toQueryString,
	type WorkspaceUrlState,
} from "../url-state";

/** The state a share link needs. Matches the workspace parameters exactly. */
export interface ShareState {
	readonly sourceLang: string;
	readonly targetLang: string;
	readonly text: string;
	readonly mode?: string;
}

/** A prepared share link plus whether it actually carries the source text. */
export interface ShareLink {
	readonly url: string;
	/** False when the text was too long to publish, so the link is partial. */
	readonly includesText: boolean;
	/** Set when `includesText` is false, for the interface to report. */
	readonly notice?: string;
}

/**
 * Build the share link for a translation.
 *
 * The query string comes from `url-state`, so the parameters are byte-identical
 * to what the workspace itself writes.
 */
export function buildShareLink(state: ShareState, origin = ""): ShareLink {
	const urlState: WorkspaceUrlState = {
		sourceLang: state.sourceLang,
		targetLang: state.targetLang,
		text: state.text,
		...(state.mode !== undefined && { mode: state.mode }),
	};

	const query = toQueryString(urlState);
	const includesText = isTextPublishable(state.text);

	return {
		url: `${origin}${query === "" ? "" : `?${query}`}`,
		includesText,
		// Only present when something is missing, so the interface shows a warning
		// exactly when there is one.
		...(includesText
			? {}
			: {
					notice: `原文超过 ${MAX_URL_TEXT_LENGTH} 字符，分享链接不包含原文；接收者只会得到语言方向。`,
				}),
	};
}

/** The text to put in an outbound share message. */
export function shareMessage(targetText: string): string {
	return targetText;
}

/** A `mailto:` link carrying the translation. */
export function buildMailtoLink(
	targetText: string,
	subject = "来自 MinTranslate 的译文",
): string {
	// `encodeURIComponent` is what keeps newlines (`%0A`) and `&` intact inside the
	// body: building the string by hand would let a `&` start a new header.
	const body = encodeURIComponent(shareMessage(targetText));
	return `mailto:?subject=${encodeURIComponent(subject)}&body=${body}`;
}

/** An X (Twitter) intent link carrying the translation. */
export function buildSocialLink(targetText: string): string {
	const text = encodeURIComponent(shareMessage(targetText));
	return `https://twitter.com/intent/tweet?text=${text}`;
}

/** What the interface needs to render the share entry point. */
export interface ShareChannelPlan {
	/**
	 * Whether the system share sheet should be the primary action.
	 *
	 * Decided here rather than in the component so the preference order is
	 * testable: system sheet when available, built-in channels otherwise.
	 */
	readonly preferSystemShare: boolean;
	/** Always present; used when the system sheet is unavailable or fails. */
	readonly fallback: readonly ("copy" | "mail" | "social")[];
}

/**
 * Decide which share channels to present.
 *
 * The built-in channels are always available as a fallback — a missing
 * `navigator.share` must not mean "no sharing", and neither must a system sheet
 * that throws.
 */
export function planShareChannels(
	systemShareAvailable: boolean,
): ShareChannelPlan {
	return {
		preferSystemShare: systemShareAvailable,
		fallback: ["copy", "mail", "social"],
	};
}

/**
 * Whether a rejected system share is just the user cancelling.
 *
 * The Web Share API rejects with `AbortError` when the user dismisses the sheet.
 * Reporting that as a failure would show an error for a completely normal action.
 */
export function isShareCancellation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { name?: unknown; message?: unknown };

	return (
		candidate.name === "AbortError" ||
		(typeof candidate.message === "string" &&
			/cancel|dismiss|abort/i.test(candidate.message))
	);
}
