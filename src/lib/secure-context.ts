/**
 * Secure-context decision used by the application shell.
 *
 * Kept as a pure function so the decision table can be verified without a
 * browser: a headless browser cannot be driven reliably in every environment,
 * but the rule the shell follows is a single boolean.
 */

/**
 * Whether the insecure-context notice must be shown.
 *
 * `undefined` means the context has not been resolved yet. The shell is
 * prerendered at build time, where there is no `window`, so the notice stays
 * hidden until hydration has read the real value. That keeps the prerendered
 * shell and the first client render identical, and avoids a flash of a notice
 * that may not apply.
 *
 * The notice appears only for a confirmed insecure context (`false`) — that is
 * the case where service worker registration and installation are genuinely
 * unavailable.
 */
export function shouldShowInsecureContextNotice(
	isSecureContext: boolean | undefined,
): boolean {
	return isSecureContext === false;
}
