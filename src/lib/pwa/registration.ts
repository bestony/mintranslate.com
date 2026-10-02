/**
 * Service worker registration.
 *
 * Registration is deliberately conditional and never fatal:
 *
 * - **Secure context only.** A browser refuses to register a worker on an
 *   insecure origin. Attempting it would produce a console error that looks like
 *   a bug; skipping it means the existing insecure-context notice explains the
 *   situation instead (see `spa-shell`).
 * - **Never throws.** Offline capability is an enhancement. If registration is
 *   blocked, unsupported, or fails, everything else must keep working.
 *
 * The worker itself is generated at build time; this module only asks the browser
 * to use it, and hands back a handle so the update flow can drive it.
 */

import { logger } from "../logger";

/** Scope-relative path of the generated worker. */
export const SERVICE_WORKER_URL = "sw.js";

/** The worker handle this module needs. */
export interface RegistrationLike {
	/** Ask the browser to activate this worker now. */
	update?: () => Promise<unknown>;
	/** True while a newer worker is installed but waiting to activate. */
	waiting: unknown | null;
	/** Present on newer browsers; used to detect a controller change. */
	active?: unknown | null;
	/** Request activation of a waiting worker (sends `SKIP_WAITING`). */
	postMessage?: (message: unknown) => void;
}

/** The slice of the browser API this module needs, injectable for tests. */
export interface RegistrationEnvironment {
	/** Whether the page runs in a secure context. */
	isSecureContext(): boolean;
	/** Whether the browser exposes service worker support at all. */
	supported(): boolean;
	/** Register the worker, resolved relative to the deployment base. */
	register(
		url: string,
		options: { readonly scope: string },
	): Promise<RegistrationLike>;
	/** Subscribe to controller changes; returns an unsubscribe function. */
	onControllerChange?(listener: () => void): () => void;
}

/** Outcome of a registration attempt. */
export type RegistrationOutcome =
	| { readonly kind: "registered"; readonly registration: RegistrationLike }
	| {
			readonly kind: "skipped";
			readonly reason: "insecure-context" | "unsupported";
	  }
	| { readonly kind: "failed"; readonly reason: string };

/** Registration surface used by the application. */
export interface ServiceWorkerRegistration {
	/** Register if permitted. Idempotent. */
	register(): Promise<RegistrationOutcome>;
	/** The registration, once obtained. */
	current(): RegistrationLike | undefined;
	/** Release the controller-change subscription. */
	dispose(): void;
}

export interface RegistrationDeps {
	readonly environment?: RegistrationEnvironment;
}

/** Real environment, backed by the browser APIs. */
export function createBrowserRegistrationEnvironment(): RegistrationEnvironment {
	/** The worker registry, when the environment has one. */
	const registry = (): ServiceWorkerContainer | undefined =>
		(globalThis as unknown as { navigator?: Navigator }).navigator
			?.serviceWorker;

	return {
		isSecureContext: () => globalThis.isSecureContext === true,
		supported: () => typeof registry()?.register === "function",
		register: (url, options) => {
			const container = registry();
			if (container === undefined) {
				return Promise.reject(new Error("service workers unavailable"));
			}
			return container.register(
				url,
				options,
			) as unknown as Promise<RegistrationLike>;
		},
		onControllerChange: (listener) => {
			const container = registry();
			if (container === undefined) return () => {};

			container.addEventListener("controllerchange", listener);
			return () => container.removeEventListener("controllerchange", listener);
		},
	};
}

/**
 * Create the registration owner.
 *
 * The base path is taken from the document rather than passed in, so a sub-path
 * deployment registers its own worker under its own scope by construction: the
 * URL is resolved relative to the page that loads it.
 */
export function createServiceWorkerRegistration(
	deps: RegistrationDeps = {},
): ServiceWorkerRegistration {
	const environment =
		deps.environment ?? createBrowserRegistrationEnvironment();

	let registration: RegistrationLike | undefined;
	let inFlight: Promise<RegistrationOutcome> | undefined;
	let unsubscribe: (() => void) | undefined;

	return {
		async register() {
			if (inFlight) return inFlight;

			inFlight = (async (): Promise<RegistrationOutcome> => {
				// The notice for this case is owned by the shell; nothing to do here.
				if (!environment.isSecureContext()) {
					logger.debug("pwa.register.skipped", { reason: "insecure-context" });
					return { kind: "skipped", reason: "insecure-context" };
				}

				if (!environment.supported()) {
					logger.debug("pwa.register.skipped", { reason: "unsupported" });
					return { kind: "skipped", reason: "unsupported" };
				}

				try {
					// Resolved against the document so the scope follows the base path.
					const url = new URL(SERVICE_WORKER_URL, document.baseURI).href;
					const scope = new URL(".", document.baseURI).pathname;

					const result = await environment.register(url, { scope });
					registration = result;

					// A controller change means another tab (or a reload) activated a new
					// worker; the update flow surfaces that to this tab.
					unsubscribe = environment.onControllerChange?.(() => {
						logger.info("pwa.controller.changed");
					});

					logger.info("pwa.register.done");
					return { kind: "registered", registration: result };
				} catch (error) {
					// Swallowed on purpose: an environment that blocks workers must not
					// break the application.
					logger.warn("pwa.register.failed", { error });
					return { kind: "failed", reason: String(error) };
				}
			})();

			return inFlight;
		},

		current: () => registration,

		dispose() {
			unsubscribe?.();
			unsubscribe = undefined;
		},
	};
}
