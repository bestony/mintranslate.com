/** Hydration-safe translation-memory preference. */

export const TRANSLATION_MEMORY_ENABLED_KEY =
	"mintranslate.translation-memory-enabled.v1";

export interface TranslationMemoryPreference {
	/** Read localStorage once after the caller has mounted. */
	mount(): boolean;
	/** Current in-memory value; this never reads storage implicitly. */
	isEnabled(): boolean;
	/** Persist a new value when storage is available. */
	setEnabled(enabled: boolean): void;
}

/** Create a preference that is safe to construct during SSR. */
export function createTranslationMemoryPreference(
	options: {
		readonly storage?: Storage;
		readonly defaultEnabled?: boolean;
		readonly key?: string;
	} = {},
): TranslationMemoryPreference {
	let enabled = options.defaultEnabled ?? true;
	let mounted = false;
	const key = options.key ?? TRANSLATION_MEMORY_ENABLED_KEY;

	function storage(): Storage | undefined {
		if (options.storage !== undefined) return options.storage;
		if (typeof window === "undefined") return undefined;
		try {
			return window.localStorage;
		} catch {
			return undefined;
		}
	}

	return {
		mount() {
			if (mounted) return enabled;
			mounted = true;
			try {
				const stored = storage()?.getItem(key);
				if (stored === "true") enabled = true;
				if (stored === "false") enabled = false;
			} catch {
				// Private browsing and strict storage policies keep the default.
			}
			return enabled;
		},
		isEnabled() {
			return enabled;
		},
		setEnabled(next) {
			enabled = next;
			try {
				storage()?.setItem(key, String(next));
			} catch {
				// A disabled or full store must not break translation.
			}
		},
	};
}

/** Read one persisted value only when the caller explicitly says it mounted. */
export function readTranslationMemoryEnabled(
	storage?: Storage,
	defaultEnabled = true,
): boolean {
	const preference = createTranslationMemoryPreference({
		storage,
		defaultEnabled,
	});
	return preference.mount();
}

export const MEMORY_ENABLED_KEY = TRANSLATION_MEMORY_ENABLED_KEY;
