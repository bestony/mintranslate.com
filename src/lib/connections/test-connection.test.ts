/**
 * Connection-test pre-flight.
 *
 * These cases exercise the mixed-content check, which runs **before** the adapter
 * is created. That ordering is the point: a plaintext endpoint is refused without
 * loading a provider package, so no network request and no dynamic import happens.
 *
 * The failing-request paths (status codes, timeouts, Body fragments) need a live
 * adapter and are covered by the attribution unit tests plus the real-browser step;
 * see tasks.md 6.4 for what remains unverified.
 *
 * `isSecureContext` is set explicitly rather than inherited, so the verdict is
 * about the code and not about whatever environment the suite runs in.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Connection } from "./model";
import { testConnection } from "./test-connection";

/** A connection to a plaintext endpoint, as an intranet model would be. */
function connection(overrides: Partial<Connection> = {}): Connection {
	return {
		id: "c1",
		name: "内网模型",
		provider: "custom",
		endpoint: "http://192.168.1.50:11434/v1",
		model: "llama3.1",
		capabilities: { text: true, vision: false },
		status: "untested",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** Whether the suite can see a `location` to derive the page origin from. */
const ORIGINAL_SECURE = Object.getOwnPropertyDescriptor(
	globalThis,
	"isSecureContext",
);

function setSecureContext(value: boolean): void {
	Object.defineProperty(globalThis, "isSecureContext", {
		configurable: true,
		value,
		writable: true,
	});
}

beforeEach(() => {
	setSecureContext(true);
});

afterEach(() => {
	if (ORIGINAL_SECURE) {
		Object.defineProperty(globalThis, "isSecureContext", ORIGINAL_SECURE);
	} else {
		Reflect.deleteProperty(globalThis, "isSecureContext");
	}
});

describe("connection test — mixed content is decided before any request", () => {
	it("refuses a plaintext endpoint from a secure page", async () => {
		const result = await testConnection(connection(), "sk-test");

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a failure");
		expect(result.attribution.type).toBe("mixed_content");
		expect(result.attribution.checklist).toBeDefined();
	});

	it("returns promptly, because no request is attempted", async () => {
		// A real attempt would wait on the adapter import and the 10s deadline; a
		// refusal is immediate. A generous bound keeps this from being flaky while
		// still catching a regression that reintroduces the request.
		const startedAt = Date.now();
		await testConnection(connection(), "sk-test");
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});

	it("carries no diagnostic fragment, since nothing was received", async () => {
		const result = await testConnection(connection(), "sk-test");
		if (result.ok) throw new Error("expected a failure");
		// A diagnostic would imply a response arrived; inventing one would
		// misrepresent a request that never left.
		expect(result.diagnostic).toBeUndefined();
	});

	it("reports the same cause the model caller reports", async () => {
		// The two paths must not disagree, or a user sees different advice for the
		// same misconfiguration depending on which action they took.
		const { createModelCaller } = await import("./model-caller");
		const { createConcurrencyLimiter } = await import(
			"../call-control/concurrency"
		);

		const caller = createModelCaller({
			limiterFor: () => createConcurrencyLimiter(),
			transport: () => Promise.resolve("unused"),
		});
		const outcome = await caller.call({
			connection: connection(),
			apiKey: "sk-test",
			requirement: "text",
			userContent: "hello",
		});

		const test = await testConnection(connection(), "sk-test");
		if (test.ok) throw new Error("expected a failure");
		if (
			outcome.kind !== "refused" ||
			outcome.refusal.kind !== "mixed_content"
		) {
			throw new Error("expected a mixed_content refusal");
		}

		expect(outcome.refusal.attribution.type).toBe(test.attribution.type);
		expect(outcome.refusal.attribution.summary).toBe(test.attribution.summary);
		expect(outcome.refusal.attribution.checklist).toEqual(
			test.attribution.checklist,
		);
	});

	it("does not refuse on an insecure page", async () => {
		setSecureContext(false);
		// A plain-HTTP page calling a plain-HTTP endpoint is not mixed content. The
		// call proceeds to the adapter and fails for some other reason; the point is
		// only that the verdict is not `mixed_content`.
		const result = await testConnection(connection(), "sk-test", {
			timeoutMs: 1500,
		});
		if (!result.ok) {
			expect(result.attribution.type).not.toBe("mixed_content");
		}
	});
});

describe("connection test — no public probes", () => {
	it("keeps the module free of network calls other than the configured endpoint", async () => {
		// A connectivity check must work in an air-gapped network, so it cannot
		// depend on reaching anything else. Asserted over the source rather than at
		// runtime: a probe would only fire under conditions this suite cannot stage.
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(
			"src/lib/connections/test-connection.ts",
			"utf8",
		);
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/.*$/gm, "$1");

		// Outbound calls must go through the adapter, which targets the user's
		// endpoint. A literal fetch/Image/beacon here would be a probe.
		expect(code).not.toMatch(/\bfetch\s*\(/);
		expect(code).not.toMatch(/\bnew\s+Image\b/);
		expect(code).not.toMatch(/navigator\.sendBeacon/);
		expect(code).not.toMatch(/XMLHttpRequest/);
	});

	it("names no public host in the test path", async () => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(
			"src/lib/connections/test-connection.ts",
			"utf8",
		);
		// Any well-known public host would mean the check depends on the internet.
		for (const host of [
			"google.com",
			"cloudflare.com",
			"1.1.1.1",
			"8.8.8.8",
			"gstatic.com",
		]) {
			expect(source).not.toContain(host);
		}
	});
});
