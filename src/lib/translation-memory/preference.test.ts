import { describe, expect, it } from "vitest";

import {
	createTranslationMemoryPreference,
	TRANSLATION_MEMORY_ENABLED_KEY,
} from ".";

function storage(initial?: string): Storage {
	let value = initial;
	return {
		getItem: () => value ?? null,
		setItem: (_key, next) => {
			value = next;
		},
		removeItem: () => {
			value = undefined;
		},
		clear: () => {
			value = undefined;
		},
		key: () => null,
		length: 0,
	};
}

describe("translation-memory preference", () => {
	it("defaults to enabled without reading storage until mount", () => {
		let reads = 0;
		const backing = storage("false");
		const controlled = {
			...backing,
			getItem(key: string) {
				reads += 1;
				return backing.getItem(key);
			},
		};
		const preference = createTranslationMemoryPreference({
			storage: controlled,
		});
		expect(preference.isEnabled()).toBe(true);
		expect(reads).toBe(0);
		expect(preference.mount()).toBe(false);
		expect(reads).toBe(1);
	});

	it("persists changes under the versioned key", () => {
		const values = new Map<string, string>();
		const fake = storage();
		fake.setItem = (key, value) => values.set(key, value);
		const preference = createTranslationMemoryPreference({ storage: fake });
		preference.mount();
		preference.setEnabled(false);
		expect(preference.isEnabled()).toBe(false);
		expect(values.get(TRANSLATION_MEMORY_ENABLED_KEY)).toBe("false");
	});
});
