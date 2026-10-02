import { describe, expect, it } from "vitest";

import {
	attributeFailure,
	CERTIFICATE_CHECKLIST,
	CORS_CHECKLIST,
	checklistFor,
	ERROR_TYPES,
	MIXED_CONTENT_CHECKLIST,
	preflightMixedContent,
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

	it("attaches the checklist to cors_or_network", () => {
		const result = attributeFailure({
			error: new TypeError("Failed to fetch"),
		});
		expect(result.checklist).toBeDefined();
		// Six items: the original four for public providers, plus two covering the
		// intranet causes a browser will not name (origin not allowed, untrusted
		// certificate).
		expect(result.checklist).toHaveLength(6);
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

	it("keeps the four original spec checklist items, in order", () => {
		// The intranet items are appended, so the original four must not move.
		expect(CORS_CHECKLIST.length).toBeGreaterThanOrEqual(4);
		expect(CORS_CHECKLIST[0]).toContain("Endpoint");
		expect(CORS_CHECKLIST[1]).toContain("允许浏览器直连");
		expect(CORS_CHECKLIST[2]).toContain("OLLAMA_ORIGINS");
		expect(CORS_CHECKLIST[3]).toContain("代理");
	});

	it("adds the intranet causes a browser will not name", () => {
		// Origin not allowed and an untrusted certificate are at least as common as
		// the four above when the endpoint is self-hosted.
		const joined = CORS_CHECKLIST.join(" ");
		expect(joined).toContain("来源");
		expect(joined).toContain("证书");
	});

	it("returns a checklist only for the causes that have one", () => {
		expect(checklistFor("cors_or_network")).toBeDefined();
		expect(checklistFor("mixed_content")).toBeDefined();
		expect(checklistFor("certificate")).toBeDefined();
		expect(checklistFor("auth_401")).toBeUndefined();
		expect(checklistFor("dns")).toBeUndefined();
	});

	it("gives each cause its own checklist rather than one shared list", () => {
		// A cause with specific guidance must not fall back to the generic four.
		expect(MIXED_CONTENT_CHECKLIST).not.toEqual(CORS_CHECKLIST);
		expect(CERTIFICATE_CHECKLIST).not.toEqual(CORS_CHECKLIST);
		expect(MIXED_CONTENT_CHECKLIST.join(" ")).toContain("HTTPS");
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
			// Appended for intranet deployments; the members above keep their names
			// and order because this enum is the analytics `error_type` contract.
			"mixed_content",
			"certificate",
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

describe("preflightMixedContent — decided before the request", () => {
	const secure = { isSecureContext: true, pageUrl: "https://app.example/" };

	it("blocks an http endpoint from a secure page", () => {
		// The browser would refuse this anyway; asking first is the only way to name
		// the cause, because the refusal itself is an opaque TypeError.
		const result = preflightMixedContent({
			...secure,
			endpoint: "http://192.168.1.50:11434/v1",
		});
		expect(result?.type).toBe("mixed_content");
		expect(result?.checklist).toEqual(MIXED_CONTENT_CHECKLIST);
	});

	it("covers plaintext schemes beyond http", () => {
		// Testing "not https" rather than "is http" is what catches these.
		for (const endpoint of ["ws://internal:8080", "ftp://internal/x"]) {
			expect(preflightMixedContent({ ...secure, endpoint })?.type).toBe(
				"mixed_content",
			);
		}
	});

	it("allows an https endpoint", () => {
		expect(
			preflightMixedContent({
				...secure,
				endpoint: "https://model.internal/v1",
			}),
		).toBeUndefined();
	});

	it("does not fire on an insecure page", () => {
		// A plain-HTTP page calling a plain-HTTP endpoint is not mixed content, so
		// reporting it as such would misdirect the user.
		expect(
			preflightMixedContent({
				isSecureContext: false,
				endpoint: "http://192.168.1.50:11434/v1",
			}),
		).toBeUndefined();
	});

	it("resolves relative endpoints against the page", () => {
		// A same-origin relative endpoint inherits the page's scheme, so it is not
		// mixed content.
		expect(
			preflightMixedContent({
				...secure,
				endpoint: new URL("/v1", "https://app.example/").toString(),
			}),
		).toBeUndefined();
	});

	it("ignores an unparsable endpoint rather than guessing", () => {
		// A malformed endpoint is a different failure; the caller reports it.
		expect(
			preflightMixedContent({ ...secure, endpoint: "not a url" }),
		).toBeUndefined();
		expect(preflightMixedContent({ ...secure, endpoint: "" })).toBeUndefined();
	});
});

describe("certificate is reported only with a readable signal", () => {
	it("classifies a certificate-naming error as certificate", () => {
		const result = attributeFailure({
			error: new Error("net::ERR_CERT_AUTHORITY_INVALID"),
		});
		expect(result.type).toBe("certificate");
		expect(result.checklist).toEqual(CERTIFICATE_CHECKLIST);
	});

	it("does not assert a certificate cause without a signal", () => {
		// The browser reports an untrusted certificate exactly as it reports a CORS
		// rejection, so the honest answer is the combined cause plus the checklist
		// item that raises the possibility.
		const result = attributeFailure({
			error: new TypeError("Failed to fetch"),
		});
		expect(result.type).toBe("cors_or_network");
		expect(result.type).not.toBe("certificate");
		expect(result.checklist).toEqual(CORS_CHECKLIST);
	});

	it("keeps every explicit-signal verdict unchanged", () => {
		// The new branches must not capture cases the old ones already decided.
		expect(attributeFailure({ httpStatus: 401 }).type).toBe("auth_401");
		expect(attributeFailure({ httpStatus: 403 }).type).toBe("forbidden_403");
		expect(attributeFailure({ httpStatus: 404 }).type).toBe("not_found_404");
		expect(attributeFailure({ httpStatus: 429 }).type).toBe("rate_limit_429");
		expect(attributeFailure({ httpStatus: 503 }).type).toBe("server_5xx");
		expect(attributeFailure({ timedOut: true }).type).toBe("timeout");
		expect(attributeFailure({ cancelledByUser: true }).type).toBe("aborted");
		expect(attributeFailure({ malformedResponse: true }).type).toBe(
			"bad_response",
		);
	});
});

describe("attribution logging", () => {
	/** Collects the events a sink receives. */
	function recorder() {
		const events: Array<{ event: string; fields: Record<string, unknown> }> =
			[];
		return {
			events,
			sink: {
				debug(event: string, fields: Record<string, unknown>) {
					events.push({ event, fields });
				},
			},
		};
	}

	it("emits one event per attribution, carrying the cause", () => {
		const { events, sink } = recorder();
		const result = attributeFailure({ httpStatus: 429 }, sink);

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("connection.attribution");
		expect(events[0].fields.cause).toBe(result.type);
		expect(events[0].fields.preflight).toBe(false);
		expect(events[0].fields.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("marks a pre-flight verdict so a missing request is not read as a bug", () => {
		const { events, sink } = recorder();
		preflightMixedContent(
			{ isSecureContext: true, endpoint: "http://internal:11434/v1" },
			sink,
		);

		expect(events).toHaveLength(1);
		expect(events[0].fields.preflight).toBe(true);
		expect(events[0].fields.signal).toBe("protocol");
	});

	it("emits nothing when the pre-flight check allows the request", () => {
		const { events, sink } = recorder();
		expect(
			preflightMixedContent(
				{ isSecureContext: true, endpoint: "https://model.internal/v1" },
				sink,
			),
		).toBeUndefined();
		expect(events).toEqual([]);
	});

	it("never logs the error message or anything key-shaped", () => {
		// A gateway can echo the credential back in its error text, so the message
		// must not reach the log even though it is what was classified.
		const { events, sink } = recorder();
		attributeFailure(
			{ error: new Error("Unauthorized: Bearer sk-live-ABCDEF0123456789") },
			sink,
		);

		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("sk-live");
		expect(serialized).not.toContain("Unauthorized");
		expect(serialized).not.toContain("Bearer");
	});
});
