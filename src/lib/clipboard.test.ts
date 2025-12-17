import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast,
}));

import { copyToClipboard } from "@/lib/clipboard";

describe("copyToClipboard", () => {
	const t = (key: string) => key;

	beforeEach(() => {
		toast.success.mockClear();
		toast.error.mockClear();
	});

	it("does nothing for empty/whitespace-only text", async () => {
		await copyToClipboard("   ", t);
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("uses navigator.clipboard when available", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		await copyToClipboard(" hello ", t);

		expect(writeText).toHaveBeenCalledWith("hello");
		expect(toast.success).toHaveBeenCalledWith("common.toasts.copied");
	});

	it("falls back to execCommand(copy) when Clipboard API unavailable", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});

		const exec = vi.fn(() => true);
		Object.defineProperty(document, "execCommand", {
			value: exec,
			configurable: true,
		});

		await copyToClipboard("hello", t);

		expect(exec).toHaveBeenCalledWith("copy");
		expect(toast.success).toHaveBeenCalledWith("common.toasts.copied");
	});

	it("shows error toast when execCommand(copy) fails", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});
		const exec = vi.fn(() => false);
		Object.defineProperty(document, "execCommand", {
			value: exec,
			configurable: true,
		});

		await copyToClipboard("hello", t);

		expect(toast.error).toHaveBeenCalledWith("common.toasts.copyFailed");
	});

	it("shows error toast when textarea cannot be created", async () => {
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
		});

		const createElement = vi
			.spyOn(document, "createElement")
			.mockImplementation(() => null as unknown as HTMLElement);

		await copyToClipboard("hello", t);

		expect(createElement).toHaveBeenCalledWith("textarea");
		expect(toast.error).toHaveBeenCalledWith("common.toasts.copyFailed");
	});

	it("shows error toast when clipboard write fails", async () => {
		const writeText = vi.fn().mockRejectedValue(new Error("nope"));
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		await copyToClipboard("hello", t);

		expect(toast.error).toHaveBeenCalledWith("common.toasts.copyFailed");
	});
});
