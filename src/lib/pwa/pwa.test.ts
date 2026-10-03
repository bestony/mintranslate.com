import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createConnectivityState,
	FEATURE_KINDS,
	isFeatureAvailable,
	requiresNetwork,
	unavailableReason,
} from "./offline";
import {
	createServiceWorkerRegistration,
	type RegistrationEnvironment,
	type RegistrationLike,
	type WaitingWorkerLike,
} from "./registration";
import {
	createUpdateFlow,
	SKIP_WAITING_MESSAGE,
	UPDATE_ACTIVATION_TIMEOUT_MS,
	UPDATE_CHECK_THROTTLE_MS,
} from "./update";

/** Captured log records, so tests assert on behaviour rather than the console. */
const logs: Array<{ level: string; event: string }> = [];
vi.mock("../logger", () => ({
	logger: {
		debug: (event: string) => logs.push({ level: "debug", event }),
		info: (event: string) => logs.push({ level: "info", event }),
		warn: (event: string) => logs.push({ level: "warn", event }),
		error: (event: string) => logs.push({ level: "error", event }),
	},
}));

beforeEach(() => {
	logs.length = 0;
	vi.useFakeTimers();
	// The registration module resolves against `document.baseURI`.
	vi.stubGlobal("document", { baseURI: "https://host.example/app/" });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("offline capability rules", () => {
	it("treats translation, webpage and model list as network features", () => {
		expect(requiresNetwork("translation")).toBe(true);
		expect(requiresNetwork("webpage")).toBe(true);
		expect(requiresNetwork("modelList")).toBe(true);
	});

	it("treats local data as never requiring a network", () => {
		expect(requiresNetwork("localData")).toBe(false);
	});

	it("keeps local capabilities available offline", () => {
		// Browsing history offline is the case offline support exists for.
		expect(isFeatureAvailable("localData", false)).toBe(true);
	});

	it("makes network features unavailable offline and available online", () => {
		for (const kind of ["translation", "webpage", "modelList"] as const) {
			expect(isFeatureAvailable(kind, false), kind).toBe(false);
			expect(isFeatureAvailable(kind, true), kind).toBe(true);
		}
	});

	it("covers every declared feature kind", () => {
		for (const kind of FEATURE_KINDS) {
			expect(typeof isFeatureAvailable(kind, false)).toBe("boolean");
		}
	});

	it("explains that the cause is being offline, not the configuration", () => {
		const reason = unavailableReason("translation", false);
		expect(reason).toBeDefined();
		expect(reason).toContain("离线");
		// A user must not be sent looking at their model settings for a network problem.
		expect(reason).not.toContain("模型配置");
	});

	it("gives no reason when the feature is available", () => {
		expect(unavailableReason("translation", true)).toBeUndefined();
		expect(unavailableReason("localData", false)).toBeUndefined();
	});

	it("has a reason for every network feature", () => {
		for (const kind of ["translation", "webpage", "modelList"] as const) {
			expect(unavailableReason(kind, false), kind).toBeDefined();
		}
	});
});

describe("connectivity state", () => {
	it("reports the environment value", () => {
		const state = createConnectivityState({
			isOnline: () => false,
			subscribe: () => () => {},
		});
		expect(state.online()).toBe(false);
	});

	it("forwards change events and can unsubscribe", () => {
		let listener: ((online: boolean) => void) | undefined;
		const unsubscribe = vi.fn();
		const state = createConnectivityState({
			isOnline: () => true,
			subscribe: (next) => {
				listener = next;
				return unsubscribe;
			},
		});

		const seen: boolean[] = [];
		const stop = state.subscribe((online) => seen.push(online));

		listener?.(false);
		expect(seen).toEqual([false]);

		stop();
		expect(unsubscribe).toHaveBeenCalled();
	});
});

describe("service worker registration", () => {
	/** Build a registration environment, overriding one dimension at a time. */
	function environment(overrides: Partial<RegistrationEnvironment> = {}) {
		const register = vi.fn().mockResolvedValue({ waiting: null });
		const env: RegistrationEnvironment = {
			isSecureContext: () => true,
			supported: () => true,
			register,
			...overrides,
		};
		return { env, register };
	}

	it("registers in a secure context when supported", async () => {
		const { env, register } = environment();
		const registration = createServiceWorkerRegistration({ environment: env });

		const outcome = await registration.register();
		expect(outcome.kind).toBe("registered");
		expect(register).toHaveBeenCalledTimes(1);
	});

	it("does not register in an insecure context", async () => {
		const { env, register } = environment({ isSecureContext: () => false });
		const registration = createServiceWorkerRegistration({ environment: env });

		const outcome = await registration.register();
		expect(outcome).toEqual({ kind: "skipped", reason: "insecure-context" });
		// The existing insecure-context notice covers this; no registration attempt.
		expect(register).not.toHaveBeenCalled();
	});

	it("does not register when the browser has no support", async () => {
		const { env, register } = environment({ supported: () => false });
		const registration = createServiceWorkerRegistration({ environment: env });

		const outcome = await registration.register();
		expect(outcome).toEqual({ kind: "skipped", reason: "unsupported" });
		expect(register).not.toHaveBeenCalled();
	});

	it("resolves the worker against the document so the scope follows the base path", async () => {
		vi.stubGlobal("document", {
			baseURI: "https://host.example/mintranslate/",
		});
		const { env, register } = environment();
		const registration = createServiceWorkerRegistration({ environment: env });

		await registration.register();
		expect(register).toHaveBeenCalledWith(
			"https://host.example/mintranslate/sw.js",
			{
				scope: "/mintranslate/",
			},
		);
	});

	it("resolves to the site root for a root deployment", async () => {
		vi.stubGlobal("document", { baseURI: "https://host.example/" });
		const { env, register } = environment();
		const registration = createServiceWorkerRegistration({ environment: env });

		await registration.register();
		expect(register).toHaveBeenCalledWith("https://host.example/sw.js", {
			scope: "/",
		});
	});

	it("swallows a registration failure", async () => {
		const { env } = environment({
			register: vi.fn().mockRejectedValue(new Error("blocked by policy")),
		});
		const registration = createServiceWorkerRegistration({ environment: env });

		const outcome = await registration.register();
		expect(outcome.kind).toBe("failed");
		expect(logs.some((entry) => entry.event === "pwa.register.failed")).toBe(
			true,
		);
	});

	it("is idempotent", async () => {
		const { env, register } = environment();
		const registration = createServiceWorkerRegistration({ environment: env });

		await registration.register();
		await registration.register();
		expect(register).toHaveBeenCalledTimes(1);
	});

	it("exposes the registration once obtained", async () => {
		const { env } = environment();
		const registration = createServiceWorkerRegistration({ environment: env });
		expect(registration.current()).toBeUndefined();

		await registration.register();
		expect(registration.current()).toBeDefined();
	});

	it("releases the controller-change subscription on dispose", async () => {
		const unsubscribe = vi.fn();
		const { env } = environment({ onControllerChange: () => unsubscribe });
		const registration = createServiceWorkerRegistration({ environment: env });

		await registration.register();
		registration.dispose();
		expect(unsubscribe).toHaveBeenCalled();
	});

	it("logs skipping, which is otherwise invisible", async () => {
		const { env } = environment({ isSecureContext: () => false });
		await createServiceWorkerRegistration({ environment: env }).register();
		expect(logs.some((entry) => entry.event === "pwa.register.skipped")).toBe(
			true,
		);
	});
});

describe("update flow", () => {
	function waitingWorker() {
		let state = "installed";
		const listeners = new Set<() => void>();
		const worker: WaitingWorkerLike = {
			get state() {
				return state;
			},
			postMessage: vi.fn(),
			addEventListener: (_type, listener) => {
				listeners.add(listener);
			},
			removeEventListener: (_type, listener) => {
				listeners.delete(listener);
			},
		};

		return {
			worker,
			activate() {
				state = "activated";
				for (const listener of listeners) listener();
			},
		};
	}

	function harness(
		options: { readonly waiting?: RegistrationLike["waiting"] } = {},
	) {
		const registration: RegistrationLike = {
			waiting: options.waiting ?? null,
			update: vi.fn().mockResolvedValue(undefined),
		};
		const probe = vi.fn().mockResolvedValue(undefined);
		const reload = vi.fn();

		const flow = createUpdateFlow({
			registration: () => registration,
			probe,
			reload,
		});

		return { flow, registration, probe, reload };
	}

	it("does not auto-reload when an update is available", async () => {
		const { flow, reload } = harness({ waiting: {} });
		flow.markWaiting();

		expect(flow.current().updateReady).toBe(true);
		// The whole point: the user decides, not the worker.
		expect(reload).not.toHaveBeenCalled();
	});

	it("sends the activation message to the waiting worker", async () => {
		const waiting = waitingWorker();
		const { flow, reload } = harness({ waiting: waiting.worker });
		flow.markWaiting();
		const applying = flow.apply();

		expect(waiting.worker.postMessage).toHaveBeenCalledWith(
			SKIP_WAITING_MESSAGE,
		);
		// Reloading before activation can still load the old active worker.
		expect(reload).not.toHaveBeenCalled();

		waiting.activate();
		await applying;
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("keeps the update available when activation does not finish", async () => {
		const waiting = waitingWorker();
		const { flow, reload } = harness({ waiting: waiting.worker });
		flow.markWaiting();

		const applying = flow.apply();
		await vi.advanceTimersByTimeAsync(UPDATE_ACTIVATION_TIMEOUT_MS);
		await applying;

		expect(reload).not.toHaveBeenCalled();
		expect(flow.current().updateReady).toBe(true);
		expect(
			logs.some((entry) => entry.event === "pwa.update.activation.failed"),
		).toBe(true);
	});

	it("reloads even without a waiting worker so the action is not a no-op", () => {
		const { flow, reload } = harness({ waiting: null });
		flow.apply();

		expect(reload).toHaveBeenCalledTimes(1);
		expect(
			logs.some((entry) => entry.event === "pwa.update.reload.without-waiting"),
		).toBe(true);
	});

	it("probes on request", async () => {
		const { flow, probe } = harness();
		flow.check();
		await vi.advanceTimersByTimeAsync(0);
		expect(probe).toHaveBeenCalled();
	});

	it("throttles repeated checks", async () => {
		const { flow, probe } = harness();

		flow.check();
		flow.check();
		flow.check();
		await vi.advanceTimersByTimeAsync(0);

		// Only the leading check runs inside the window.
		expect(probe).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(UPDATE_CHECK_THROTTLE_MS);
		flow.check();
		await vi.advanceTimersByTimeAsync(0);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("reports being up to date after an explicit check", async () => {
		const { flow } = harness({ waiting: null });
		await flow.checkNow();

		// Silence after an explicit request would read as a broken button.
		expect(flow.current().upToDateNotice).toBeDefined();
	});

	it("does not claim up to date when an update is waiting", async () => {
		const { flow } = harness({ waiting: {} });
		await flow.checkNow();

		expect(flow.current().updateReady).toBe(true);
		expect(flow.current().upToDateNotice).toBeUndefined();
	});

	it("survives a failing probe", async () => {
		const flow = createUpdateFlow({
			registration: () => ({ waiting: null }),
			probe: vi.fn().mockRejectedValue(new Error("offline")),
			reload: vi.fn(),
		});

		await expect(flow.checkNow()).resolves.toBeUndefined();
		expect(
			logs.some((entry) => entry.event === "pwa.update.check.failed"),
		).toBe(true);
	});

	it("treats a controller change as an available update", () => {
		const { flow } = harness();
		flow.markControllerChanged();

		// Another tab activated a worker; this tab is now behind it.
		expect(flow.current().updateReady).toBe(true);
		expect(
			logs.some((entry) => entry.event === "pwa.update.controller-changed"),
		).toBe(true);
	});

	it("does not require a dedicated constructor for the controller case", async () => {
		// The decision is "listen to controllerchange", not "add a cross-tab channel".
		const source = await import("node:fs").then((fs) =>
			fs.readFileSync("src/lib/pwa/update.ts", "utf8"),
		);
		for (const channel of [
			"BroadcastChannel",
			"localStorage",
			"SharedWorker",
		]) {
			expect(source).not.toContain(channel);
		}
	});

	it("notifies subscribers of state changes", () => {
		const { flow } = harness();
		const states: boolean[] = [];
		const stop = flow.subscribe((state) => states.push(state.updateReady));

		flow.markWaiting();
		flow.markControllerChanged();
		expect(states).toEqual([true, true]);

		stop();
		flow.markWaiting();
		expect(states).toHaveLength(2);
	});

	it("uses a ten second throttle window", () => {
		expect(UPDATE_CHECK_THROTTLE_MS).toBe(10_000);
	});

	it("stops notifying after dispose", () => {
		const { flow } = harness();
		const seen: boolean[] = [];
		flow.subscribe((state) => seen.push(state.updateReady));

		flow.markWaiting();
		expect(seen).toHaveLength(1);

		flow.dispose();
		// A disposed flow must not reach listeners again.
		flow.markWaiting();
		flow.markControllerChanged();
		expect(seen).toHaveLength(1);
	});

	it("is safe to dispose twice", () => {
		const { flow } = harness();
		flow.dispose();
		expect(() => flow.dispose()).not.toThrow();
	});
});
