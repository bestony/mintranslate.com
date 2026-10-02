/**
 * Application update flow.
 *
 * Three rules shape this module, all from the PRD:
 *
 * 1. **Download silently, never take over.** A new worker installs and waits. The
 *    page is not reloaded behind the user's back — losing a half-typed
 *    translation to an automatic refresh is the failure mode this avoids.
 * 2. **Check on a throttle.** Update probes are triggered by user actions, so
 *    without a throttle a burst of clicks becomes a burst of requests. The shared
 *    call-control primitive does the throttling; no bespoke timer is added.
 * 3. **Never hide a manual check's outcome.** If a user explicitly asks "is there
 *    a new version?", silence is the wrong answer — they get told either way.
 *
 * A controller change (another tab activated a worker) is treated as "an update
 * happened" for this tab too. That costs one event listener and no cross-tab
 * channel.
 */

import { throttle } from "../call-control/throttle";
import { logger } from "../logger";
import type { RegistrationLike } from "./registration";

/** Update probe throttle window. */
export const UPDATE_CHECK_THROTTLE_MS = 10_000;

/** Message a waiting worker understands. */
export const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" } as const;

/** Where the update flow gets its worker handle and how it probes. */
export interface UpdateEnvironment {
	/** The current registration, when one exists. */
	registration(): RegistrationLike | undefined;
	/** Ask the browser to check for a new worker. */
	probe(): Promise<void>;
	/** Reload the page to pick up the new worker. */
	reload(): void;
}

/** What the interface needs to render the update prompt. */
export interface UpdateState {
	/** True when a new version is downloaded and waiting. */
	readonly updateReady: boolean;
	/** Set when a manual check found nothing, so the user is not left guessing. */
	readonly upToDateNotice?: string;
}

/** Update flow surface. */
export interface UpdateFlow {
	/** Subscribe to state changes. */
	subscribe(listener: (state: UpdateState) => void): () => void;
	current(): UpdateState;
	/** Check for updates, throttled. */
	check(): void;
	/** Check for updates now, bypassing the throttle (used by the manual entry). */
	checkNow(): Promise<void>;
	/** Apply the waiting update: activate it and reload. */
	apply(): void;
	/** Note that a newer worker is waiting (called by the registration owner). */
	markWaiting(): void;
	/** Note a controller change, which means another tab activated an update. */
	markControllerChanged(): void;
	dispose(): void;
}

export function createUpdateFlow(environment: UpdateEnvironment): UpdateFlow {
	const listeners = new Set<(state: UpdateState) => void>();
	let state: UpdateState = { updateReady: false };

	function emit(next: UpdateState): void {
		state = next;
		for (const listener of listeners) listener(state);
	}

	/**
	 * Throttled probe.
	 *
	 * Leading-edge only: the first check runs immediately (so the UI feels
	 * responsive) and repeated triggers inside the window are absorbed.
	 */
	const throttledCheck = throttle(
		() => {
			void runProbe();
		},
		UPDATE_CHECK_THROTTLE_MS,
		{ leading: true, trailing: false },
	);

	/** Run one probe and record the outcome. */
	async function runProbe(): Promise<void> {
		try {
			await environment.probe();
			// The browser reports a waiting worker through the registration, not
			// through the probe's return value.
			const waiting = environment.registration()?.waiting ?? null;
			emit(waiting === null ? { updateReady: false } : { updateReady: true });
			logger.debug("pwa.update.checked", { updateReady: state.updateReady });
		} catch (error) {
			logger.warn("pwa.update.check.failed", { error });
		}
	}

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		current: () => state,

		check() {
			throttledCheck();
		},

		async checkNow() {
			await runProbe();

			// An explicit request deserves an answer even when there is nothing new.
			if (!state.updateReady) {
				emit({ updateReady: false, upToDateNotice: "当前已是最新版本。" });
			}
		},

		apply() {
			const waiting = environment.registration()?.waiting;
			if (waiting === null || waiting === undefined) {
				// Nothing waiting: fall back to a plain reload so the action still
				// does something rather than appearing broken.
				logger.info("pwa.update.reload.without-waiting");
				environment.reload();
				return;
			}

			logger.info("pwa.update.applying");
			// Only the page can ask the waiting worker to take over, which is what
			// keeps activation user-driven rather than automatic.
			environment.registration()?.postMessage?.(SKIP_WAITING_MESSAGE);
			environment.reload();
		},

		markWaiting() {
			emit({ updateReady: true });
			logger.info("pwa.update.ready");
		},

		markControllerChanged() {
			// Another tab activated a newer worker: this tab is now behind it.
			emit({ updateReady: true });
			logger.info("pwa.update.controller-changed");
		},

		dispose() {
			throttledCheck.cancel();
			listeners.clear();
		},
	};
}

/** Real environment, backed by a registration and `location.reload`. */
export function createBrowserUpdateEnvironment(
	registration: () => RegistrationLike | undefined,
): UpdateEnvironment {
	return {
		registration,
		probe: async () => {
			await registration()?.update?.();
		},
		reload: () => {
			globalThis.location?.reload();
		},
	};
}
