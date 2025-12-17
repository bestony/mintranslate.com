import { describe, expect, it } from "vitest";

import { baseOptions } from "@/lib/layout.shared";
import { i18n } from "@/lib/i18n";

describe("baseOptions", () => {
	it("returns stable layout options", () => {
		const options = baseOptions();
		expect(options.i18n).toBe(i18n);
		expect(options.nav.title).toBe("MinTranslate");
	});
});

