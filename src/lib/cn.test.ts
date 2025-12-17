import { describe, expect, it } from "vitest";

import { cn } from "@/lib/cn";

describe("cn (tailwind-merge re-export)", () => {
	it("merges tailwind classes", () => {
		expect(cn("px-2", "px-4")).toBe("px-4");
	});
});

