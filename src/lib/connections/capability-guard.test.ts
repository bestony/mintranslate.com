import { describe, expect, it } from "vitest";

import { canServe, capabilityBlocker } from "./capability-guard";
import type { Connection } from "./model";

function connection(
	capabilities: Connection["capabilities"],
): Pick<Connection, "capabilities" | "name"> {
	return { name: "test-connection", capabilities };
}

describe("capability guard", () => {
	it("refuses an image call on a text-only connection", () => {
		const blocker = capabilityBlocker(
			connection({ text: true, vision: false }),
			"vision",
		);
		expect(blocker).toBeDefined();
		expect(blocker).toContain("不支持图片输入");
		expect(blocker).toContain("多模态");
	});

	it("allows an image call on a vision connection", () => {
		expect(
			capabilityBlocker(connection({ text: true, vision: true }), "vision"),
		).toBeUndefined();
	});

	it("allows a text call on a text connection", () => {
		expect(
			capabilityBlocker(connection({ text: true, vision: false }), "text"),
		).toBeUndefined();
	});

	it("refuses a text call when text capability is off", () => {
		const blocker = capabilityBlocker(
			connection({ text: false, vision: true }),
			"text",
		);
		expect(blocker).toContain("未标记为可处理文本");
	});

	it("names the connection in the refusal so the user knows which one", () => {
		const blocker = capabilityBlocker(
			connection({ text: true, vision: false }),
			"vision",
		);
		expect(blocker).toContain("test-connection");
	});

	it("exposes canServe as the boolean form", () => {
		expect(canServe(connection({ text: true, vision: false }), "vision")).toBe(
			false,
		);
		expect(canServe(connection({ text: true, vision: false }), "text")).toBe(
			true,
		);
	});
});
