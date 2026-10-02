import { describe, expect, it } from "vitest";

import {
	decideRetry,
	describeWait,
	isRateLimited,
	parseRetryAfter,
	rateLimitDelayMs,
	resolveBackoffPolicy,
} from "./backoff";

describe("parseRetryAfter", () => {
	it("parses a delay in seconds", () => {
		expect(parseRetryAfter("3")).toBe(3000);
		expect(parseRetryAfter("0")).toBe(0);
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseRetryAfter("  5  ")).toBe(5000);
	});

	it("parses an HTTP date relative to now", () => {
		const now = Date.parse("2026-10-02T00:00:00Z");
		const future = new Date(now + 7000).toUTCString();
		expect(parseRetryAfter(future, now)).toBe(7000);
	});

	it("rejects a date in the past so the caller falls back", () => {
		const now = Date.parse("2026-10-02T00:00:00Z");
		const past = new Date(now - 5000).toUTCString();
		expect(parseRetryAfter(past, now)).toBeUndefined();
	});

	it("rejects nonsense rather than waiting on it", () => {
		expect(parseRetryAfter("soon")).toBeUndefined();
		expect(parseRetryAfter("")).toBeUndefined();
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter(undefined)).toBeUndefined();
	});
});

describe("resolveBackoffPolicy", () => {
	it("defaults to one retry with a one second base", () => {
		expect(resolveBackoffPolicy()).toEqual({
			maxRetries: 1,
			baseDelayMs: 1000,
		});
	});

	it("clamps negatives to zero", () => {
		expect(resolveBackoffPolicy({ maxRetries: -3, baseDelayMs: -5 })).toEqual({
			maxRetries: 0,
			baseDelayMs: 0,
		});
	});
});

describe("rateLimitDelayMs", () => {
	it("prefers Retry-After over the computed backoff", () => {
		// The endpoint knows its own refill schedule, so its value wins.
		expect(rateLimitDelayMs({ attempt: 1, retryAfter: 4200 })).toBe(4200);
	});

	it("grows exponentially with the attempt when no Retry-After is given", () => {
		const policy = resolveBackoffPolicy({ baseDelayMs: 1000 });
		expect(rateLimitDelayMs({ attempt: 1, policy })).toBe(1000);
		expect(rateLimitDelayMs({ attempt: 2, policy })).toBe(2000);
		expect(rateLimitDelayMs({ attempt: 3, policy })).toBe(4000);
	});

	it("stays finite for a large attempt count", () => {
		const policy = resolveBackoffPolicy({ baseDelayMs: 1000 });
		expect(Number.isFinite(rateLimitDelayMs({ attempt: 1000, policy }))).toBe(
			true,
		);
	});
});

describe("decideRetry", () => {
	it("retries once after the first failure", () => {
		const decision = decideRetry({ attemptsSoFar: 0 });
		expect(decision.kind).toBe("retry");
		if (decision.kind === "retry") expect(decision.waitMs).toBeGreaterThan(0);
	});

	it("gives up after the retry budget is spent", () => {
		const decision = decideRetry({ attemptsSoFar: 1 });
		expect(decision.kind).toBe("give-up");
	});

	it("never retries when the cap is zero", () => {
		const decision = decideRetry({
			attemptsSoFar: 0,
			policy: { maxRetries: 0 },
		});
		expect(decision.kind).toBe("give-up");
		if (decision.kind === "give-up")
			expect(decision.reason).toContain("已禁用");
	});

	it("returns the Retry-After wait on the retry decision", () => {
		const decision = decideRetry({ attemptsSoFar: 0, retryAfter: 9000 });
		expect(decision.kind).toBe("retry");
		if (decision.kind === "retry") expect(decision.waitMs).toBe(9000);
	});

	it("still reports a wait when giving up, for the user-facing hint", () => {
		const decision = decideRetry({ attemptsSoFar: 1, retryAfter: 2500 });
		expect(decision.waitMs).toBe(2500);
	});
});

describe("isRateLimited", () => {
	it("recognizes 429 only", () => {
		expect(isRateLimited(429)).toBe(true);
		expect(isRateLimited(401)).toBe(false);
		expect(isRateLimited(500)).toBe(false);
		expect(isRateLimited(undefined)).toBe(false);
	});
});

describe("describeWait", () => {
	it("rounds up to whole seconds", () => {
		expect(describeWait(1500)).toContain("2 秒");
		expect(describeWait(1000)).toContain("1 秒");
	});
});
