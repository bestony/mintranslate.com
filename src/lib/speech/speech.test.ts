import { describe, expect, it, vi } from "vitest";

import {
	createSpeechController,
	isCancellation,
	type SpeechEngine,
} from "./controller";
import { loadSpeechRate, SPEECH_RATE_KEY, saveSpeechRate } from "./persistence";
import {
	DEFAULT_SPEECH_RATE,
	isSpeechRate,
	rateLabel,
	rateValue,
	SPEECH_RATES,
} from "./rates";
import { selectVoice, utteranceLang } from "./voice";

/**
 * A speech engine test double that records every call.
 *
 * When `gated` is set, each `speak` returns a promise the test resolves
 * individually. Holding a *specific* segment is what makes the cancellation
 * assertions (does the queue stop?) possible without real time.
 */
function fakeEngine(
	options: {
		readonly available?: boolean;
		readonly voices?: readonly {
			name: string;
			lang: string;
			default?: boolean;
		}[];
		readonly gated?: boolean;
	} = {},
) {
	const spoken: Array<{
		text: string;
		rate: number;
		lang: string;
		voiceName?: string;
	}> = [];
	const gates: Array<() => void> = [];
	let cancelCount = 0;
	let voiceListener: (() => void) | undefined;
	let voices = options.voices ?? [{ name: "V", lang: "en-US" }];

	const engine: SpeechEngine = {
		isAvailable: () => options.available ?? true,
		async speak(text, opts) {
			spoken.push({ text, ...opts });
			if (!options.gated) return;
			await new Promise<void>((resolve) => {
				gates.push(resolve);
			});
		},
		cancel() {
			cancelCount += 1;
		},
		voices: () => voices,
		onVoicesChanged(listener) {
			voiceListener = listener;
			return () => {
				voiceListener = undefined;
			};
		},
	};

	return {
		engine,
		spoken,
		cancelCount: () => cancelCount,
		/** Release the segment that is currently in flight. */
		releaseGate() {
			gates.shift()?.();
		},
		/**
		 * Release segments until none remain pending.
		 *
		 * A read queues its next segment only after the current one settles, so a
		 * single release is not enough: this yields between releases until the
		 * queue drains.
		 */
		async drainGates() {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (gates.length === 0) {
					await new Promise((resolve) => setTimeout(resolve, 0));
					if (gates.length === 0) return;
				}
				gates.shift()?.();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},
		/**
		 * Wait until at least `count` segments have started.
		 *
		 * Yields a macrotask each round: the controller chains several promises
		 * before reaching `engine.speak`, and a microtask-only loop never lets
		 * those continuations run.
		 */
		async waitForSpeakCount(count: number) {
			for (
				let attempt = 0;
				attempt < 100 && spoken.length < count;
				attempt += 1
			) {
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},
		/** Simulate the browser delivering its voice list late. */
		deliverVoices(
			next: readonly { name: string; lang: string; default?: boolean }[],
		) {
			voices = next;
			voiceListener?.();
		},
		hasListener: () => voiceListener !== undefined,
	};
}

/** Alias used by the cancellation tests; same helper, clearer name there. */
const harnessHarness = harness;

function harness(engineOptions: Parameters<typeof fakeEngine>[0] = {}) {
	const states: boolean[] = [];
	const fake = fakeEngine(engineOptions);
	const controller = createSpeechController({
		engine: fake.engine,
		callbacks: { onStateChange: (speaking) => states.push(speaking) },
		// A trivial segmenter keeps these tests about sequencing, not splitting.
		segment: (text) => text.split("|").filter((part) => part !== ""),
	});
	return { ...fake, controller, states };
}

describe("rate tiers", () => {
	it("exposes exactly three tiers", () => {
		expect(SPEECH_RATES).toEqual(["normal", "slow", "slower"]);
	});

	it("maps tiers to monotonically increasing rates", () => {
		expect(rateValue("normal")).toBeGreaterThan(rateValue("slow"));
		expect(rateValue("slow")).toBeGreaterThan(rateValue("slower"));
	});

	it("uses 1 as the normal rate", () => {
		expect(rateValue("normal")).toBe(1);
	});

	it("defaults to normal", () => {
		expect(DEFAULT_SPEECH_RATE).toBe("normal");
	});

	it("labels every tier", () => {
		for (const rate of SPEECH_RATES) expect(rateLabel(rate)).not.toBe("");
	});

	it("validates tier names", () => {
		expect(isSpeechRate("slow")).toBe(true);
		expect(isSpeechRate("fastest")).toBe(false);
		expect(isSpeechRate(42)).toBe(false);
	});
});

describe("voice selection", () => {
	const voices = [
		{ name: "Samantha", lang: "en-US" },
		{ name: "Ting-Ting", lang: "zh-CN" },
		{ name: "Mei-Jia", lang: "zh-TW" },
		{ name: "Sinji", lang: "zh-HK" },
	];

	it("matches Simplified Chinese to a zh-CN voice", () => {
		expect(selectVoice(voices, "zh-Hans")?.name).toBe("Ting-Ting");
	});

	it("prefers zh-TW for Traditional Chinese", () => {
		expect(selectVoice(voices, "zh-Hant")?.name).toBe("Mei-Jia");
	});

	it("falls back to zh-HK when zh-TW is absent", () => {
		const withoutTW = voices.filter((voice) => voice.lang !== "zh-TW");
		expect(selectVoice(withoutTW, "zh-Hant")?.name).toBe("Sinji");
	});

	it("does not use a Simplified voice for Traditional text", () => {
		// Reading Traditional text with a Simplified voice is audibly wrong, so the
		// variant ordering must hold.
		const onlySimplified = [{ name: "Ting-Ting", lang: "zh-CN" }];
		expect(selectVoice(onlySimplified, "zh-Hant")).toBeUndefined();
	});

	it("matches by prefix rather than exact equality", () => {
		expect(selectVoice([{ name: "X", lang: "en-GB" }], "en")?.name).toBe("X");
	});

	it("handles underscore-separated tags", () => {
		expect(selectVoice([{ name: "X", lang: "zh_CN" }], "zh-Hans")?.name).toBe(
			"X",
		);
	});

	it("returns undefined when nothing matches", () => {
		expect(selectVoice([{ name: "X", lang: "fr-FR" }], "ja")).toBeUndefined();
	});

	it("returns undefined for an empty voice list", () => {
		expect(selectVoice([], "en")).toBeUndefined();
	});

	it("prefers the platform default within a matching tag", () => {
		const pair = [
			{ name: "A", lang: "en-US" },
			{ name: "B", lang: "en-US", default: true },
		];
		expect(selectVoice(pair, "en")?.name).toBe("B");
	});

	it("handles unknown languages by base prefix", () => {
		expect(selectVoice([{ name: "X", lang: "sv-SE" }], "sv")?.name).toBe("X");
	});

	it("produces a concrete language tag for the utterance", () => {
		expect(utteranceLang("zh-Hans")).toBe("zh-CN");
		expect(utteranceLang("zh-Hant")).toBe("zh-TW");
	});
});

describe("speech controller", () => {
	it("reports unavailable when the engine cannot speak", async () => {
		const { controller } = harness({ available: false });
		expect(controller.available()).toBe(false);

		await controller.speak("hello", { rate: 1, language: "en" });
		// No speech attempted, and no false "speaking" state.
		expect(controller.busy()).toBe(false);
	});

	it("does nothing for empty text", async () => {
		const { controller, spoken } = harness();
		await controller.speak("", { rate: 1, language: "en" });
		expect(spoken).toHaveLength(0);
	});

	it("speaks a single segment", async () => {
		const { controller, spoken } = harness();
		await controller.speak("hello", { rate: 1, language: "en" });
		expect(spoken.map((s) => s.text)).toEqual(["hello"]);
	});

	it("speaks segments in order", async () => {
		const { controller, spoken } = harness();
		await controller.speak("one|two|three", { rate: 1, language: "en" });
		expect(spoken.map((s) => s.text)).toEqual(["one", "two", "three"]);
	});

	it("passes the rate through to the engine", async () => {
		const { controller, spoken } = harness();
		await controller.speak("hello", {
			rate: rateValue("slower"),
			language: "en",
		});
		expect(spoken[0].rate).toBe(rateValue("slower"));
	});

	it("passes the matched voice name", async () => {
		const { controller, spoken } = harness({
			voices: [{ name: "Ting-Ting", lang: "zh-CN" }],
		});
		await controller.speak("你好", { rate: 1, language: "zh-Hans" });
		expect(spoken[0].voiceName).toBe("Ting-Ting");
	});

	it("speaks without a voice when none matches", async () => {
		// A missing voice must not disable the feature: the language tag still lets
		// the browser choose.
		const { controller, spoken } = harness({
			voices: [{ name: "Only", lang: "fr-FR" }],
		});
		await controller.speak("こんにちは", { rate: 1, language: "ja" });
		expect(spoken).toHaveLength(1);
		expect(spoken[0].voiceName).toBeUndefined();
		expect(spoken[0].lang).toBe("ja-JP");
	});

	it("uses a late-arriving voice list", async () => {
		const { controller, spoken, deliverVoices, hasListener } = harness({
			voices: [{ name: "Old", lang: "en-US" }],
		});
		expect(hasListener()).toBe(true);

		// The browser reports a better voice after the fact.
		deliverVoices([{ name: "Late", lang: "zh-CN" }]);
		await controller.speak("你好", { rate: 1, language: "zh-Hans" });

		expect(spoken[0].voiceName).toBe("Late");
	});

	it("reports speaking state while talking", async () => {
		const { controller, states } = harness();
		await controller.speak("hello", { rate: 1, language: "en" });
		expect(states[0]).toBe(true);
		expect(states[states.length - 1]).toBe(false);
	});

	it("stops and clears state", async () => {
		const { controller, states, cancelCount } = harness();
		controller.stop();
		expect(cancelCount()).toBeGreaterThan(0);
		expect(states[states.length - 1]).toBe(false);
	});

	it("reports not busy when idle", () => {
		const { controller } = harness();
		expect(controller.busy()).toBe(false);
	});
});

describe("cancellation within one read", () => {
	it("does not continue to later segments after stop", async () => {
		const fake = harnessHarness({ gated: true });

		const pending = fake.controller.speak("one|two|three", {
			rate: 1,
			language: "en",
		});
		await fake.waitForSpeakCount(1);

		// Stop while the first segment is still in flight.
		fake.controller.stop();
		await fake.drainGates();
		await pending;

		// The remaining segments were never started.
		expect(fake.spoken.map((s) => s.text)).toEqual(["one"]);
	});

	it("starts a fresh read from the first segment after a stop", async () => {
		const fake = harnessHarness({ gated: true });

		const first = fake.controller.speak("a|b", { rate: 1, language: "en" });
		await fake.waitForSpeakCount(1);
		fake.controller.stop();
		fake.releaseGate();
		await first;

		const before = fake.spoken.length;
		const second = fake.controller.speak("x|y", { rate: 1, language: "en" });
		await fake.waitForSpeakCount(before + 1);
		await fake.drainGates();
		await second;

		// The new read begins at its own first segment, not at a leftover 'b'.
		expect(fake.spoken.slice(before).map((s) => s.text)).toEqual(["x", "y"]);
	});

	it("cancels the engine when a new read supersedes the old one", async () => {
		const fake = harnessHarness({ gated: true });

		const first = fake.controller.speak("one|two", { rate: 1, language: "en" });
		await fake.waitForSpeakCount(1);
		const before = fake.cancelCount();

		const second = fake.controller.speak("fresh", { rate: 1, language: "en" });
		// A new user request must stop the previous one rather than queue behind it.
		expect(fake.cancelCount()).toBeGreaterThan(before);

		await fake.drainGates();
		await Promise.all([first, second]);
	});

	it("does not let a superseded read clear the speaking state", async () => {
		const states: boolean[] = [];
		const fake = fakeEngine({ gated: true });
		const controller = createSpeechController({
			engine: fake.engine,
			callbacks: { onStateChange: (speaking) => states.push(speaking) },
			segment: (text) => text.split("|").filter((part) => part !== ""),
		});

		const first = controller.speak("one", { rate: 1, language: "en" });
		await fake.waitForSpeakCount(1);
		const second = controller.speak("two", { rate: 1, language: "en" });
		await fake.waitForSpeakCount(2);

		await fake.drainGates();
		await Promise.all([second, first]);

		// The last reported state is "not speaking" only once the current read ended;
		// the superseded read must not have left it falsely true or falsely false mid-read.
		expect(states[states.length - 1]).toBe(false);
	});
});

describe("rate persistence", () => {
	function storage(seed: Record<string, string> = {}) {
		const data = { ...seed };
		return {
			data,
			getItem: (key: string) => data[key] ?? null,
			setItem: (key: string, value: string) => {
				data[key] = value;
			},
		};
	}

	it("round-trips a chosen tier", () => {
		const store = storage();
		saveSpeechRate("slower", store);
		expect(loadSpeechRate(store)).toBe("slower");
	});

	it("defaults when nothing is stored", () => {
		expect(loadSpeechRate(storage())).toBe(DEFAULT_SPEECH_RATE);
	});

	it("falls back on an invalid stored value", () => {
		expect(loadSpeechRate(storage({ [SPEECH_RATE_KEY]: "supersonic" }))).toBe(
			DEFAULT_SPEECH_RATE,
		);
	});

	it("uses a versioned slot name", () => {
		expect(SPEECH_RATE_KEY).toBe("mintranslate.speech-rate.v1");
	});

	it("survives storage that throws", () => {
		const throwing = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(loadSpeechRate(throwing)).toBe(DEFAULT_SPEECH_RATE);
		expect(() => saveSpeechRate("slow", throwing)).not.toThrow();
	});

	it("defaults when no storage is available at all", () => {
		expect(loadSpeechRate(undefined)).toBe(DEFAULT_SPEECH_RATE);
		expect(() => saveSpeechRate("slow", undefined)).not.toThrow();
	});
});

describe("disposal", () => {
	it("cancels speech and releases the voice subscription", () => {
		const { controller, hasListener, cancelCount } = harness();
		expect(hasListener()).toBe(true);

		controller.dispose();

		expect(hasListener()).toBe(false);
		expect(cancelCount()).toBeGreaterThan(0);
	});

	it("is safe to dispose twice", () => {
		const { controller } = harness();
		controller.dispose();
		expect(() => controller.dispose()).not.toThrow();
	});
});

describe("cancellation detection", () => {
	it("recognizes an abort error", () => {
		const error = new Error("aborted");
		error.name = "AbortError";
		expect(isCancellation(error)).toBe(true);
	});

	it("recognizes an interruption message", () => {
		expect(isCancellation(new Error("speech was interrupted"))).toBe(true);
	});

	it("does not treat a real failure as cancellation", () => {
		expect(isCancellation(new Error("synthesis failed"))).toBe(false);
		expect(isCancellation(undefined)).toBe(false);
	});
});

describe("engine replacement keeps the app working", () => {
	it("never throws when speaking with an unavailable engine", async () => {
		const { controller } = harness({ available: false });
		await expect(
			controller.speak("x", { rate: 1, language: "en" }),
		).resolves.toBeUndefined();
	});

	it("survives an engine whose speak rejects", async () => {
		const failure = vi.fn();
		const engine: SpeechEngine = {
			isAvailable: () => true,
			speak: async () => {
				throw new Error("device busy");
			},
			cancel: () => {},
			voices: () => [],
		};
		const controller = createSpeechController({
			engine,
			callbacks: { onStateChange: () => {}, onError: failure },
			segment: (text) => [text],
		});

		await expect(
			controller.speak("x", { rate: 1, language: "en" }),
		).rejects.toThrow();
	});
});
