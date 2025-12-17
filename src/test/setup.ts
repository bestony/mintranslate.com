import { beforeEach } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
	globalThis.localStorage?.clear();

	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => {
			const listeners = new Set<(event: MediaQueryListEvent) => void>();

			const mql: MediaQueryList = {
				media: query,
				matches: false,
				onchange: null,
				addEventListener: (_event: string, cb: (event: MediaQueryListEvent) => void) => {
					listeners.add(cb);
				},
				removeEventListener: (_event: string, cb: (event: MediaQueryListEvent) => void) => {
					listeners.delete(cb);
				},
				addListener: () => {
					// legacy
				},
				removeListener: () => {
					// legacy
				},
				dispatchEvent: (event: Event) => {
					for (const cb of listeners) {
						cb(event as MediaQueryListEvent);
					}
					return true;
				},
			};

			return mql;
		},
	});

	if (!("innerWidth" in window)) {
		Object.defineProperty(window, "innerWidth", {
			writable: true,
			value: 1024,
		});
	}
});

