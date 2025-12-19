import { beforeEach } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function ensureLocalStorage() {
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);

	const storage = descriptor?.value as
		| {
				getItem?: (key: string) => string | null;
				setItem?: (key: string, value: string) => void;
				removeItem?: (key: string) => void;
				clear?: () => void;
		  }
		| undefined;

	const hasStorage =
		storage &&
		typeof storage.getItem === "function" &&
		typeof storage.setItem === "function" &&
		typeof storage.removeItem === "function" &&
		typeof storage.clear === "function";

	if (hasStorage) return;

	class MemoryStorage {
		private store = new Map<string, string>();

		get length() {
			return this.store.size;
		}

		clear() {
			this.store.clear();
		}

		getItem(key: string) {
			return this.store.has(key) ? (this.store.get(key) ?? null) : null;
		}

		key(index: number) {
			return Array.from(this.store.keys())[index] ?? null;
		}

		removeItem(key: string) {
			this.store.delete(key);
		}

		setItem(key: string, value: string) {
			this.store.set(String(key), String(value));
		}
	}

	const memoryStorage = new MemoryStorage();

	Object.defineProperty(globalThis, "localStorage", {
		value: memoryStorage,
		writable: true,
		configurable: true,
	});

	if (typeof window !== "undefined") {
		Object.defineProperty(window, "localStorage", {
			value: memoryStorage,
			writable: true,
			configurable: true,
		});
	}

	Object.defineProperty(globalThis, "Storage", {
		value: MemoryStorage,
		writable: true,
		configurable: true,
	});

	if (typeof window !== "undefined") {
		Object.defineProperty(window, "Storage", {
			value: MemoryStorage,
			writable: true,
			configurable: true,
		});
	}
}

ensureLocalStorage();

beforeEach(() => {
	globalThis.localStorage?.clear?.();

	if (typeof window === "undefined") {
		return;
	}

	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => {
			const listeners = new Set<(event: MediaQueryListEvent) => void>();

			const mql: MediaQueryList = {
				media: query,
				matches: false,
				onchange: null,
				addEventListener: (
					_event: string,
					listener: EventListenerOrEventListenerObject,
				) => {
					if (typeof listener === "function") {
						listeners.add(listener as (event: MediaQueryListEvent) => void);
					}
				},
				removeEventListener: (
					_event: string,
					listener: EventListenerOrEventListenerObject,
				) => {
					if (typeof listener === "function") {
						listeners.delete(listener as (event: MediaQueryListEvent) => void);
					}
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
