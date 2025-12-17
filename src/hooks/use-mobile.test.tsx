import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useIsMobile } from "@/hooks/use-mobile";

describe("useIsMobile", () => {
	it("returns false on first render and updates after effect", async () => {
		let mql: MediaQueryList | null = null;

		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: () => {
				const listeners = new Set<(event: MediaQueryListEvent) => void>();
				mql = {
					media: "",
					matches: false,
					onchange: null,
					addEventListener: (_event, cb) => listeners.add(cb),
					removeEventListener: (_event, cb) => listeners.delete(cb),
					addListener: () => {
						// legacy
					},
					removeListener: () => {
						// legacy
					},
					dispatchEvent: (event: Event) => {
						for (const cb of listeners) cb(event as MediaQueryListEvent);
						return true;
					},
				} as MediaQueryList;
				return mql;
			},
		});

		window.innerWidth = 500;
		const { result } = renderHook(() => useIsMobile());

		expect(result.current).toBe(false);

		await waitFor(() => {
			expect(result.current).toBe(true);
		});

		expect(mql).not.toBeNull();
	});

	it("responds to matchMedia change events and cleans up", async () => {
		const addEventListener = vi.fn();
		const removeEventListener = vi.fn();
		let listener: ((event: MediaQueryListEvent) => void) | null = null;

		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: () =>
				({
					media: "",
					matches: false,
					onchange: null,
					addEventListener: (_event: string, cb: (event: MediaQueryListEvent) => void) => {
						addEventListener();
						listener = cb;
					},
					removeEventListener: (_event: string, _cb: (event: MediaQueryListEvent) => void) => {
						removeEventListener();
						listener = null;
					},
					addListener: () => {
						// legacy
					},
					removeListener: () => {
						// legacy
					},
					dispatchEvent: () => true,
				}) as MediaQueryList,
		});

		window.innerWidth = 500;
		const { result, unmount } = renderHook(() => useIsMobile());

		await waitFor(() => {
			expect(result.current).toBe(true);
		});

		window.innerWidth = 1024;
		act(() => {
			listener?.(new Event("change") as MediaQueryListEvent);
		});

		await waitFor(() => {
			expect(result.current).toBe(false);
		});

		unmount();

		expect(addEventListener).toHaveBeenCalledTimes(1);
		expect(removeEventListener).toHaveBeenCalledTimes(1);
	});
});

