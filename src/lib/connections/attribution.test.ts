import { describe, expect, it } from "vitest";

import {
	attributeFailure,
	CORS_CHECKLIST,
	checklistFor,
	ERROR_TYPES,
} from "./attribution";

describe("attributeFailure — explicit signals", () => {
	it("classifies 401 as an authentication failure", () => {
		const result = attributeFailure({ httpStatus: 401 });
		expect(result.type).toBe("auth_401");
	});

	it("classifies 403 as a permission failure", () => {
		expect(attributeFailure({ httpStatus: 403 }).type).toBe("forbidden_403");
	});

	it("classifies 404 as model-or-path-not-found", () => {
		expect(attributeFailure({ httpStatus: 404 }).type).toBe("not_found_404");
	});

	it("classifies 429 as rate limiting, not authentication", () => {
		expect(attributeFailure({ httpStatus: 429 }).type).toBe("rate_limit_429");
	});

	it("classifies 5xx as a server error", () => {
		for (const status of [500, 502, 503, 504, 599]) {
			expect(attributeFailure({ httpStatus: status }).type).toBe("server_5xx");
		}
	});

	it("classifies an unparsable body as bad_response, distinct from CORS", () => {
		const result = attributeFailure({
			httpStatus: 200,
			malformedResponse: true,
		});
		expect(result.type).toBe("bad_response");
	});

	it("classifies our own deadline as timeout", () => {
		expect(attributeFailure({ timedOut: true }).type).toBe("timeout");
	});

	it("classifies a user cancellation as aborted, not as an error", () => {
		const result = attributeFailure({
			cancelledByUser: true,
			error: new TypeError("Failed to fetch"),
		});
		expect(result.type).toBe("aborted");
	});
});

describe("attributeFailure — rejections without a response", () => {
	it("classifies a TypeError failed-to-fetch as cors_or_network", () => {
		const result = attributeFailure({
			error: new TypeError("Failed to fetch"),
		});
		expect(result.type).toBe("cors_or_network");
	});

	it("classifies a Firefox-style network error as cors_or_network", () => {
		expect(
			attributeFailure({
				error: new TypeError("NetworkError when attempting to fetch resource."),
			}).type,
		).toBe("cors_or_network");
	});

	it("attaches the four-item checklist to cors_or_network", () => {
		const result = attributeFailure({
			error: new TypeError("Failed to fetch"),
		});
		expect(result.checklist).toBeDefined();
		expect(result.checklist).toHaveLength(4);
	});

	it("classifies an unresolved hostname as dns when it is stated", () => {
		const error = new Error("getaddrinfo ENOTFOUND api.example.invalid");
		expect(attributeFailure({ error }).type).toBe("dns");
	});

	it("falls back to unknown for an unrecognized error", () => {
		expect(attributeFailure({ error: new Error("something odd") }).type).toBe(
			"unknown",
		);
	});

	it("falls back to unknown when nothing is provided", () => {
		expect(attributeFailure({}).type).toBe("unknown");
	});
});

describe("cors_or_network honesty", () => {
	it("does not assert a definite CORS cause in its summary", () => {
		const result = attributeFailure({
			error: new TypeError("Failed to fetch"),
		});
		// The browser does not tell us the reason, so the text must not claim one.
		expect(result.summary).toContain("可能是跨域被拒，也可能是网络不可达");
		expect(result.summary).toContain("浏览器不会说明具体原因");
	});

	it("exposes exactly the four spec checklist items", () => {
		expect(CORS_CHECKLIST).toHaveLength(4);
		expect(CORS_CHECKLIST[0]).toContain("Endpoint");
		expect(CORS_CHECKLIST[1]).toContain("允许浏览器直连");
		expect(CORS_CHECKLIST[2]).toContain("OLLAMA_ORIGINS");
		expect(CORS_CHECKLIST[3]).toContain("代理");
	});

	it("returns a checklist only for cors_or_network", () => {
		expect(checklistFor("cors_or_network")).toBeDefined();
		expect(checklistFor("auth_401")).toBeUndefined();
	});
});

describe("error type enum", () => {
	it("matches the analytics error_type set exactly", () => {
		// Keeping these aligned means the analytics change needs no translation.
		expect([...ERROR_TYPES]).toEqual([
			"cors_or_network",
			"dns",
			"timeout",
			"auth_401",
			"forbidden_403",
			"not_found_404",
			"rate_limit_429",
			"server_5xx",
			"bad_response",
			"aborted",
			"unknown",
		]);
	});

	it("produces only values from the closed enum", () => {
		const inputs = [
			{ httpStatus: 401 },
			{ httpStatus: 403 },
			{ httpStatus: 404 },
			{ httpStatus: 429 },
			{ httpStatus: 500 },
			{ httpStatus: 418 },
			{ timedOut: true },
			{ cancelledByUser: true },
			{ malformedResponse: true },
			{ error: new TypeError("Failed to fetch") },
			{ error: new Error("ENOTFOUND x") },
			{},
		];
		for (const input of inputs) {
			expect(ERROR_TYPES).toContain(attributeFailure(input).type);
		}
	});
});
