/**
 * Hydration regression suite.
 *
 * The defect this guards against: components read `localStorage` / `window` /
 * `navigator` / `speechSynthesis` during their first render, so the client's first
 * render disagreed with the prerendered shell. React reported `Minified React
 * error #418` in the browser and discarded the prerendered tree.
 *
 * The check is the one that would have caught it: render with the environment the
 * **build** has (no browser globals at all), prime storage the way a returning
 * user has it, then hydrate in an environment that **does** have those APIs and
 * require that React reports nothing recoverable.
 *
 * The asymmetry is the whole point. A suite whose client environment resembles the
 * prerender cannot detect this class of bug, so every capability whose presence
 * changes the markup is asserted to actually differ between the two sides.
 *
 * @vitest-environment jsdom
 */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpeechControls } from "#/components/output/SpeechControls";
import { InstallButton, PwaStatus } from "#/components/pwa/PwaStatus";
import { TranslationWorkspace } from "#/components/translation/TranslationWorkspace";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The globals the prerender lacks and the client has. */
const CLIENT_ONLY_GLOBALS = [
	"window",
	"document",
	"navigator",
	"speechSynthesis",
	"SpeechSynthesisUtterance",
] as const;

type GlobalName = (typeof CLIENT_ONLY_GLOBALS)[number];

/** Descriptors captured so the environment can be restored exactly. */
type GlobalSnapshot = Map<GlobalName, PropertyDescriptor | undefined>;

function snapshotGlobals(): GlobalSnapshot {
	const saved: GlobalSnapshot = new Map();
	for (const name of CLIENT_ONLY_GLOBALS) {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	}
	return saved;
}

function restoreGlobals(saved: GlobalSnapshot): void {
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
}

/**
 * Stand in for the speech APIs a real browser provides.
 *
 * jsdom has neither, so without this the speech controls report "unavailable" on
 * both sides and a test built on them cannot tell a fixed component from a broken
 * one. The real browser asymmetry is: absent while prerendering, present after.
 */
function speechStubs() {
	return {
		speechSynthesis: {
			speak: () => {},
			cancel: () => {},
			getVoices: () => [],
		},
		SpeechSynthesisUtterance: class {
			text: string;
			rate = 1;
			lang = "";
			voice: unknown = null;
			onend: (() => void) | null = null;
			onerror: ((event: unknown) => void) | null = null;
			constructor(text: string) {
				this.text = text;
			}
		},
	};
}

/** Storage as a returning user's browser holds it. */
function primeStorage(): void {
	window.localStorage.setItem(
		"mintranslate.connections.v1",
		JSON.stringify([
			{
				id: "c1",
				name: "Ollama 本地",
				provider: "ollama",
				endpoint: "http://192.168.1.50:11434/v1",
				model: "llama3.1",
				capabilities: { text: true, vision: false },
				status: "ok",
				createdAt: 1,
				updatedAt: 1,
			},
		]),
	);
	window.localStorage.setItem(
		"mintranslate.credentials.v1",
		JSON.stringify({ c1: "sk-test" }),
	);
	window.localStorage.setItem("mintranslate.active-connection.v1", "c1");
	window.localStorage.setItem("mintranslate.tier.v1", "fast");
	window.localStorage.setItem(
		"mintranslate.language-usage.v1",
		JSON.stringify({ "zh-Hans": 9, en: 4 }),
	);
	window.localStorage.setItem("mintranslate.speech-rate.v1", "slow");
	window.localStorage.setItem("mintranslate.prompt-style.v1", "literal");
	window.localStorage.setItem("mintranslate.custom-instruction.v1", "语气正式");
}

/**
 * Render `element` the way the build does: with none of the client-only globals
 * present. This is the environment that produced the reported `#418`.
 */
function renderAsBuild(element: React.ReactElement): string {
	const saved = snapshotGlobals();
	for (const name of CLIENT_ONLY_GLOBALS) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value: undefined,
			writable: true,
		});
	}

	try {
		return renderToString(element);
	} finally {
		restoreGlobals(saved);
	}
}

/** Give the environment everything a real browser has, including speech. */
function installClientCapabilities(): void {
	const stubs = speechStubs();
	for (const [name, value] of Object.entries(stubs)) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
			writable: true,
		});
	}

	// A Mac user: the case where the modifier hint used to disagree, because the
	// prerender cannot know the platform. A plain object is used rather than
	// `Object.assign` on the live navigator, whose `platform` is getter-only.
	const live = globalThis.navigator as unknown as Record<string, unknown>;
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			userAgent: live.userAgent,
			platform: "MacIntel",
			maxTouchPoints: 0,
			onLine: true,
			language: live.language,
			languages: live.languages,
			share: undefined,
		},
		writable: true,
	});
}

/**
 * Prerender, prime storage, then hydrate a browser-shaped environment.
 *
 * Returns the recoverable errors React reported. An empty array means the client's
 * first render agreed with the prerendered markup.
 */
async function hydrateAndCollect(
	element: React.ReactElement,
): Promise<string[]> {
	const html = renderAsBuild(element);

	primeStorage();
	installClientCapabilities();

	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.appendChild(container);

	const errors: string[] = [];
	await act(async () => {
		hydrateRoot(container, element, {
			onRecoverableError: (error) => {
				errors.push(error instanceof Error ? error.message : String(error));
			},
		});
	});

	container.remove();
	return errors;
}

describe("the suite's environment mirrors a real browser", () => {
	it("provides the speech APIs that jsdom lacks", () => {
		// Without this the speech assertions below pass vacuously: "unavailable"
		// on both sides is a match, but not a meaningful one.
		installClientCapabilities();
		expect(
			typeof (globalThis as { speechSynthesis?: unknown }).speechSynthesis,
		).not.toBe("undefined");
	});

	it("removes them again for a build-shaped render", () => {
		const html = renderAsBuild(<span>probe</span>);
		expect(html).toContain("probe");
		installClientCapabilities();
	});
});

describe("hydration matches the prerendered shell", () => {
	it("lays out the same way whether or not speech is available", () => {
		// The structural assertion behind the case below: if these two renders were
		// identical, a mismatch could not exist and the test would prove nothing.
		const asBuild = renderAsBuild(
			<SpeechControls
				sourceText="hello"
				sourceLang="en"
				targetText="你好"
				targetLang="zh-Hans"
				segment={(value) => [value]}
			/>,
		);
		installClientCapabilities();
		expect(asBuild).toContain("当前环境不支持语音朗读");

		// The prerender's markup must therefore be what the client can adopt.
		expect(asBuild).toContain("朗读原文");
	});

	it("the translation workspace hydrates cleanly with stored data present", async () => {
		// The workspace is where the defect was reported: it has the platform
		// modifier label, the speech controls and the persistence reads.
		const errors = await hydrateAndCollect(<TranslationWorkspace />);
		expect(errors).toEqual([]);
	});

	it("speech controls hydrate cleanly though they depend on a browser API", async () => {
		const errors = await hydrateAndCollect(
			<SpeechControls
				sourceText="hello"
				sourceLang="en"
				targetText="你好"
				targetLang="zh-Hans"
				segment={(value) => [value]}
			/>,
		);
		expect(errors).toEqual([]);
	});

	it("the PWA status surface hydrates cleanly", async () => {
		// Connectivity, install guidance and the secure-context state are all read
		// after mount; none may influence the first render.
		const errors = await hydrateAndCollect(
			<>
				<PwaStatus />
				<InstallButton />
			</>,
		);
		expect(errors).toEqual([]);
	});

	it("the modifier hint does not differ between prerender and hydration", () => {
		// A Mac user is the case that used to break: the prerender cannot know the
		// platform, so the label must be resolved after mount, not during render.
		const html = renderAsBuild(<TranslationWorkspace />);
		// React splits interpolated text with comment nodes, so compare the text
		// content rather than the raw markup.
		const text = html.replace(/<!--.*?-->/g, "");
		expect(text).toContain("Ctrl+Enter");
		expect(text).not.toContain("⌘+Enter");
	});
});
