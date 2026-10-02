import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type ControllerCallbacks,
	createTranslationController,
	type TranslationInput,
	type TranslationRunner,
} from "../translation/controller";
import type { TranslationMemoryPort } from ".";

function input(text = "hello"): TranslationInput {
	return {
		text,
		sourceLang: "en",
		targetLang: "zh-Hans",
		connectionId: "connection",
		composing: false,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function harness(memory: TranslationMemoryPort, run?: TranslationRunner) {
	const events: string[] = [];
	const callbacks: ControllerCallbacks = {
		onStart: (id) => events.push(`start:${id}`),
		onChunk: (id, delta) => events.push(`chunk:${id}:${delta}`),
		onSuccess: (_id, text) => events.push(`success:${text}`),
		onFailure: (id) => events.push(`failure:${id}`),
		onSuperseded: (id) => events.push(`superseded:${id}`),
	};
	const runner = vi.fn(run ?? (async () => ({ text: "model" })));
	const controller = createTranslationController({
		memory,
		run: runner,
		callbacks,
		memoryEnabled: true,
	});
	return { controller, events, runner };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("translation-memory controller integration", () => {
	it("returns an exact hit without calling the model", async () => {
		const memory: TranslationMemoryPort = {
			findTranslation: vi.fn().mockResolvedValue("cached"),
			writeTranslation: vi.fn().mockResolvedValue([]),
		};
		const { controller, events, runner } = harness(memory);
		controller.update(input());
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(runner).not.toHaveBeenCalled();
		expect(events).toContain("success:cached");
		expect(memory.findTranslation).toHaveBeenCalledWith(
			"hello",
			expect.objectContaining({ sl: "en", tl: "zh-Hans" }),
		);
	});

	it("does not let a superseded hit write an old result", async () => {
		const first = deferred<string | undefined>();
		const memory: TranslationMemoryPort = {
			findTranslation: vi
				.fn()
				.mockImplementationOnce(() => first.promise)
				.mockResolvedValue("fresh"),
			writeTranslation: vi.fn().mockResolvedValue([]),
		};
		const { controller, events, runner } = harness(memory);
		controller.update(input("old"));
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(401);
		controller.update(input("new"));
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);
		expect(memory.findTranslation).toHaveBeenCalledTimes(2);
		first.resolve("stale");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(runner).not.toHaveBeenCalled();
		expect(events).toContain("success:fresh");
		expect(events).not.toContain("success:stale");
	});

	it("writes only final model output after a miss", async () => {
		const memory: TranslationMemoryPort = {
			findTranslation: vi.fn().mockResolvedValue(undefined),
			writeTranslation: vi.fn().mockResolvedValue([]),
		};
		const { controller, events, runner } = harness(memory, async (options) => {
			options.onChunk("partial");
			return { text: "final" };
		});
		controller.update(input("source"));
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(runner).toHaveBeenCalledTimes(1);
		expect(events).toContain("success:final");
		expect(memory.writeTranslation).toHaveBeenCalledWith(
			"source",
			"final",
			expect.objectContaining({ sl: "en", tl: "zh-Hans" }),
		);
	});

	it("does not read or write memory when disabled", async () => {
		const memory: TranslationMemoryPort = {
			findTranslation: vi.fn().mockResolvedValue("cached"),
			writeTranslation: vi.fn().mockResolvedValue([]),
		};
		const runner: TranslationRunner = async () => ({ text: "model" });
		const callbacks: ControllerCallbacks = {
			onStart: vi.fn(),
			onChunk: vi.fn(),
			onSuccess: vi.fn(),
			onFailure: vi.fn(),
		};
		const controller = createTranslationController({
			memory,
			run: runner,
			callbacks,
			memoryEnabled: false,
		});
		controller.update(input());
		controller.trigger();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(memory.findTranslation).not.toHaveBeenCalled();
		expect(memory.writeTranslation).not.toHaveBeenCalled();
		expect(callbacks.onSuccess).toHaveBeenCalled();
	});
});
