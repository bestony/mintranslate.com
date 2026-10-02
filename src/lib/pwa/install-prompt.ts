/**
 * Install prompt owner.
 *
 * The browser fires `beforeinstallprompt` once and the captured event can be
 * prompted **once**. That makes it a single-owner resource: if several components
 * each captured their own copy, the second one to call `prompt()` would throw,
 * and the availability flag would disagree between them.
 *
 * So the event is captured here, in module scope, and components subscribe. This is
 * the one piece of PWA state that must be shared rather than instantiated per
 * component.
 */

/** The event shape Chromium fires. */
export interface InstallPromptEventLike extends Event {
	readonly prompt: () => Promise<void>;
	readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

type Listener = () => void;

let captured: InstallPromptEventLike | undefined;
let installed = false;
const listeners = new Set<Listener>();
let listening = false;

function notify(): void {
	for (const listener of listeners) listener();
}

/**
 * Start listening for the install prompt.
 *
 * Idempotent: repeated calls do not add more listeners, which is what keeps a
 * component that mounts twice from capturing the event twice.
 */
export function observeInstallPrompt(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;

	window.addEventListener("beforeinstallprompt", (event) => {
		// Suppress the browser's own banner: the application provides its own entry,
		// and two competing prompts is worse than one.
		event.preventDefault();
		captured = event as InstallPromptEventLike;
		notify();
	});

	window.addEventListener("appinstalled", () => {
		// The event is consumed by installation; it cannot be prompted again.
		captured = undefined;
		installed = true;
		notify();
	});
}

/** Whether a prompt can be shown right now. */
export function canPromptInstall(): boolean {
	return captured !== undefined && !installed;
}

/** Whether the app is known to be installed. */
export function isInstalled(): boolean {
	return installed;
}

/**
 * Show the prompt.
 *
 * Returns the user's choice, or `undefined` when there was nothing to prompt —
 * which also means the event is spent either way, so it is cleared.
 */
export async function promptInstall(): Promise<
	"accepted" | "dismissed" | undefined
> {
	const event = captured;
	if (event === undefined) return undefined;

	try {
		await event.prompt();
		const choice = await event.userChoice;
		return choice.outcome;
	} finally {
		// Consumed regardless of the outcome: a second prompt would throw.
		captured = undefined;
		notify();
	}
}

/** Subscribe to availability changes; returns an unsubscribe function. */
export function subscribeInstallPrompt(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Reset captured state. For tests only. */
export function resetInstallPromptForTests(): void {
	captured = undefined;
	installed = false;
	listeners.clear();
	listening = false;
}
