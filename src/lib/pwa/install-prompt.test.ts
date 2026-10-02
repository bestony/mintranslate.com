import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	canPromptInstall,
	isInstalled,
	observeInstallPrompt,
	promptInstall,
	resetInstallPromptForTests,
	subscribeInstallPrompt,
} from "./install-prompt";

/** A minimal window stand-in that records listeners and can dispatch to them. */
function fakeWindow() {
	const listeners = new Map<string, Array<(event: Event) => void>>();

	return {
		addEventListener(type: string, listener: (event: Event) => void) {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		removeEventListener() {},
		dispatch(type: string, event: Event) {
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
		listenerCount: (type: string) => (listeners.get(type) ?? []).length,
	};
}

/** An install-prompt event whose prompt resolves the given choice. */
function promptEvent(outcome: "accepted" | "dismissed" = "accepted") {
	const preventDefault = vi.fn();
	return {
		event: {
			preventDefault,
			prompt: vi.fn().mockResolvedValue(undefined),
			userChoice: Promise.resolve({ outcome }),
		} as unknown as Event,
		preventDefault,
	};
}

beforeEach(() => {
	resetInstallPromptForTests();
});

afterEach(() => {
	resetInstallPromptForTests();
	vi.unstubAllGlobals();
});

describe("install prompt ownership", () => {
	it("reports no prompt before the event arrives", () => {
		vi.stubGlobal("window", fakeWindow());
		observeInstallPrompt();
		expect(canPromptInstall()).toBe(false);
	});

	it("becomes available when the event arrives", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		observeInstallPrompt();

		const { event } = promptEvent();
		win.dispatch("beforeinstallprompt", event);

		expect(canPromptInstall()).toBe(true);
	});

	it("suppresses the browser default banner", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		observeInstallPrompt();

		const { event, preventDefault } = promptEvent();
		win.dispatch("beforeinstallprompt", event);

		// Two competing install prompts is worse than one.
		expect(preventDefault).toHaveBeenCalled();
	});

	it("installs only one listener however many times it is observed", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);

		// Several components may mount; each calls this.
		observeInstallPrompt();
		observeInstallPrompt();
		observeInstallPrompt();

		expect(win.listenerCount("beforeinstallprompt")).toBe(1);
	});

	it("returns the user choice", async () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		observeInstallPrompt();
		win.dispatch("beforeinstallprompt", promptEvent("dismissed").event);

		expect(await promptInstall()).toBe("dismissed");
	});

	it("consumes the event so a second prompt is not attempted", async () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		observeInstallPrompt();
		win.dispatch("beforeinstallprompt", promptEvent().event);

		await promptInstall();

		// Prompting the same event twice throws in the browser, so it must be spent.
		expect(canPromptInstall()).toBe(false);
		expect(await promptInstall()).toBeUndefined();
	});

	it("marks installed when the app reports installation", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		observeInstallPrompt();
		win.dispatch("beforeinstallprompt", promptEvent().event);

		win.dispatch("appinstalled", new Event("appinstalled"));

		expect(isInstalled()).toBe(true);
		expect(canPromptInstall()).toBe(false);
	});

	it("notifies subscribers of availability changes", () => {
		const win = fakeWindow();
		vi.stubGlobal("window", win);
		observeInstallPrompt();

		const seen: boolean[] = [];
		const stop = subscribeInstallPrompt(() => seen.push(canPromptInstall()));

		win.dispatch("beforeinstallprompt", promptEvent().event);
		expect(seen).toEqual([true]);

		stop();
		win.dispatch("appinstalled", new Event("appinstalled"));
		expect(seen).toHaveLength(1);
	});

	it("does nothing without a window", () => {
		expect(() => observeInstallPrompt()).not.toThrow();
		expect(canPromptInstall()).toBe(false);
	});

	it("does not resolve a prompt when nothing was captured", async () => {
		vi.stubGlobal("window", fakeWindow());
		expect(await promptInstall()).toBeUndefined();
	});
});
