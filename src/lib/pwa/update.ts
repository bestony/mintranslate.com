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
import type { RegistrationLike, WaitingWorkerLike } from "./registration";

/** Update probe throttle window. */
export const UPDATE_CHECK_THROTTLE_MS = 10_000;

/** Maximum time to wait for a worker to finish activation after confirmation. */
export const UPDATE_ACTIVATION_TIMEOUT_MS = 15_000;

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
	/** Observe a controller change caused by another tab or this update. */
	onControllerChange?(listener: () => void): () => void;
	/** Wait until a worker has activated, when the environment provides a custom wait. */
	waitForActivation?(worker: WaitingWorkerLike): Promise<boolean>;
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
	/** Apply the waiting update: activate it, then reload after activation. */
	apply(): Promise<void>;
	/** Note that a newer worker is waiting (called by the registration owner). */
	markWaiting(): void;
	/** Note a controller change, which means another tab activated an update. */
	markControllerChanged(): void;
	dispose(): void;
}

/**
 * Wait for a waiting worker to finish activation.
 *
 * Reloading immediately after `postMessage` races the browser's worker
 * lifecycle: the navigation can still be served by the old active worker. The
 * state transition is the reliable boundary before reloading.
 */
export function waitForWorkerActivation(
	worker: WaitingWorkerLike,
): Promise<boolean> {
	if (worker.state === "activated") return Promise.resolve(true);

	const addEventListener = worker.addEventListener;
	if (typeof addEventListener !== "function") {
		return Promise.resolve(false);
	}

	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (activated: boolean) => {
			if (settled) return;
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			worker.removeEventListener?.("statechange", onStateChange);
			resolve(activated);
		};

		const onStateChange = () => {
			if (worker.state === "activated") {
				finish(true);
			} else if (worker.state === "redundant") {
				finish(false);
			}
		};

		timeout = setTimeout(() => finish(false), UPDATE_ACTIVATION_TIMEOUT_MS);
		addEventListener("statechange", onStateChange);
		// The worker may have reached a terminal state between the initial check
		// and listener registration.
		onStateChange();
	});
}

export function createUpdateFlow(environment: UpdateEnvironment): UpdateFlow {
	const listeners = new Set<(state: UpdateState) => void>();
	let state: UpdateState = { updateReady: false };
	let applying = false;

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

	function markControllerChanged(): void {
		// Another tab activated a newer worker: this tab is now behind it.
		emit({ updateReady: true });
		logger.info("pwa.update.controller-changed");
	}

	const stopControllerChange = environment.onControllerChange?.(
		markControllerChanged,
	);

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

		async apply() {
			if (applying) {
				logger.debug("pwa.update.apply.skipped", {
					reason: "already-applying",
				});
				return;
			}

			const waiting = environment.registration()?.waiting;
			if (waiting === null || waiting === undefined) {
				// Nothing waiting: fall back to a plain reload so the action still
				// does something rather than appearing broken.
				logger.info("pwa.update.reload.without-waiting");
				environment.reload();
				return;
			}

			if (typeof waiting.postMessage !== "function") {
				logger.warn("pwa.update.apply.failed", {
					reason: "waiting-worker-cannot-receive-message",
				});
				return;
			}

			applying = true;
			try {
				logger.info("pwa.update.applying");
				// `postMessage` belongs to the waiting ServiceWorker, not to the
				// ServiceWorkerRegistration. Sending it to the registration is a
				// silent no-op in real browsers.
				waiting.postMessage(SKIP_WAITING_MESSAGE);

				const activated = await (environment.waitForActivation?.(waiting) ??
					waitForWorkerActivation(waiting));
				if (!activated) {
					logger.warn("pwa.update.activation.failed");
					return;
				}

				logger.info("pwa.update.reloading");
				environment.reload();
			} catch (error) {
				logger.warn("pwa.update.apply.failed", { error });
			} finally {
				applying = false;
			}
		},

		markWaiting() {
			emit({ updateReady: true });
			logger.info("pwa.update.ready");
		},

		markControllerChanged,

		dispose() {
			throttledCheck.cancel();
			stopControllerChange?.();
			listeners.clear();
		},
	};
}

/** Real environment, backed by a registration and `location.reload`. */
export function createBrowserUpdateEnvironment(
	registration: () => RegistrationLike | undefined,
): UpdateEnvironment {
	const serviceWorker = () =>
		(globalThis as unknown as { navigator?: Navigator }).navigator
			?.serviceWorker;

	return {
		registration,
		probe: async () => {
			await registration()?.update?.();
		},
		reload: () => {
			globalThis.location?.reload();
		},
		onControllerChange: (listener) => {
			const container = serviceWorker();
			if (container === undefined) return () => {};

			container.addEventListener("controllerchange", listener);
			return () => container.removeEventListener("controllerchange", listener);
		},
		waitForActivation: waitForWorkerActivation,
	};
}
