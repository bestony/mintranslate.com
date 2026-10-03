/**
 * The workspace must wait for an explicit activation before creating a model,
 * then continue the same intent after completion and keep a failed download
 * retryable.
 *
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuiltinTranslatorNotReadyError } from "#/lib/builtin-ai/translator";
import { BuiltinDownloadNotice } from "./BuiltinDownloadNotice";
import { useBuiltinDownload } from "./useBuiltinDownload";

let controls: ReturnType<typeof useBuiltinDownload> | undefined;

function Harness({
	translator,
}: {
	readonly translator: ReturnType<typeof fakeTranslator>;
}) {
	controls = useBuiltinDownload({ intentKey: "intent", translator });
	return (
		<>
			<output data-state={controls.state.phase}>{controls.state.phase}</output>
			<BuiltinDownloadNotice
				state={controls.state}
				onActivate={() => void controls?.activate()}
			/>
		</>
	);
}

function fakeTranslator() {
	return {
		availability: vi.fn(),
		create: vi.fn(),
		translate: vi.fn(),
		translateStreaming: vi.fn(),
		detect: vi.fn(),
		destroy: vi.fn(),
	};
}

describe("built-in workspace download activation", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		controls = undefined;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("does not create before click, continues after completion, and retries failures", async () => {
		const translator = fakeTranslator();
		let rejectNext = false;
		let firstDownload = true;
		let resolveDownload: (() => void) | undefined;
		let reportProgress: ((progress: number) => void) | undefined;
		translator.create.mockImplementation(
			async (
				_source: string,
				_target: string,
				options: { readonly onProgress?: (progress: number) => void },
			) => {
				reportProgress = options.onProgress;
				reportProgress?.(0.4);
				if (rejectNext) throw new Error("download failed");
				if (firstDownload) {
					firstDownload = false;
					await new Promise<void>((resolve) => {
						resolveDownload = resolve;
					});
				}
			},
		);

		await act(async () => {
			root = createRoot(container);
			root.render(<Harness translator={translator} />);
		});
		let continued = 0;
		const required = new BuiltinTranslatorNotReadyError(
			{ state: "downloadable" },
			{ sourceLanguage: "ja", targetLanguage: "en" },
		);
		await act(async () => {
			controls?.offer(required, "intent", () => {
				continued += 1;
			});
		});
		expect(translator.create).not.toHaveBeenCalled();
		expect(container.querySelector("[data-state=required]")).not.toBeNull();

		const button = () =>
			container.querySelector<HTMLButtonElement>(
				'button[name="builtin-model-download"]',
			);
		await act(async () => {
			button()?.click();
		});
		expect(translator.create).toHaveBeenCalledWith(
			"ja",
			"en",
			expect.objectContaining({ onProgress: expect.any(Function) }),
		);
		expect(reportProgress).toBeTypeOf("function");
		expect(container.querySelector("progress")).not.toBeNull();
		expect(
			container.querySelector<HTMLProgressElement>("progress")?.value,
		).toBe(0.4);
		expect(resolveDownload).toBeTypeOf("function");
		await act(async () => {
			resolveDownload?.();
			await Promise.resolve();
		});
		expect(continued).toBe(1);

		rejectNext = true;
		await act(async () => {
			controls?.offer(required, "intent", () => {
				continued += 1;
			});
		});
		await act(async () => {
			button()?.click();
			await Promise.resolve();
		});
		expect(container.querySelector("[data-state=failed]")).not.toBeNull();
		expect(continued).toBe(1);

		rejectNext = false;
		await act(async () => {
			button()?.click();
		});
		expect(translator.create).toHaveBeenCalledTimes(3);
		expect(continued).toBe(2);
	});

	it("returns false for a stale download intent so the caller shows its failure", async () => {
		const translator = fakeTranslator();
		await act(async () => {
			root = createRoot(container);
			root.render(<Harness translator={translator} />);
		});

		const required = new BuiltinTranslatorNotReadyError(
			{ state: "downloadable" },
			{ sourceLanguage: "ja", targetLanguage: "en" },
		);
		let continued = 0;
		let accepted = true;
		await act(async () => {
			accepted =
				controls?.offer(required, "stale-intent", () => {
					continued += 1;
				}) ?? false;
		});

		expect(accepted).toBe(false);
		expect(continued).toBe(0);
		expect(container.querySelector("[data-state=idle]")).not.toBeNull();
		expect(container.querySelector("[data-state=required]")).toBeNull();
	});
});
