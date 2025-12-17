import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn (utils)", () => {
	it("merges tailwind classes (last one wins)", () => {
		expect(cn("px-2", "px-4")).toBe("px-4");
	});

	it("supports conditional/falsey values via clsx", () => {
		expect(cn("p-2", false && "hidden", undefined, null, "text-sm")).toBe(
			"p-2 text-sm",
		);
	});
});

