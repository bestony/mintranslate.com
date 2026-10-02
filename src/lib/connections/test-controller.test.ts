import { describe, expect, it, vi } from "vitest";

import type { Connection } from "./model";
import type { ConnectionTestResult } from "./test-connection";
import {
	CONNECTION_TEST_COOLDOWN_MS,
	createConnectionTestController,
} from "./test-controller";

/** A promise with externally controlled resolution. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function connection(
	overrides: Partial<Connection> & Pick<Connection, "id">,
): Connection {
	return {
		name: overrides.id,
		provider: "openai",
		endpoint: "https://api.example.com/v1",
		model: "some-model",
		capabilities: { text: true, vision: false },
		status: "untested",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

const success: ConnectionTestResult = { ok: true, latencyMs: 12 };

describe("connection test controller — single flight", () => {
	it("refuses a second test while one is in flight", async () => {
		const gate = deferred<ConnectionTestResult>();
		const runTest = vi.fn().mockReturnValue(gate.promise);
		const controller = createConnectionTestController({ runTest });

		const first = controller.request(connection({ id: "a" }), "k");
		const second = await controller.request(connection({ id: "a" }), "k");

		expect(second).toEqual({
			kind: "refused",
			refusal: { kind: "in-progress" },
		});
		expect(runTest).toHaveBeenCalledTimes(1);

		gate.resolve(success);
		await first;
	});

	it("tests different connections independently", async () => {
		const runTest = vi.fn().mockResolvedValue(success);
		const controller = createConnectionTestController({ runTest });

		await Promise.all([
			controller.request(connection({ id: "a" }), "k"),
			controller.request(connection({ id: "b" }), "k"),
		]);

		expect(runTest).toHaveBeenCalledTimes(2);
	});
});

describe("connection test controller — cooldown", () => {
	it("refuses a test inside the cooldown and reports the remaining time", async () => {
		let clock = 1_000_000;
		const runTest = vi.fn().mockResolvedValue(success);
		const controller = createConnectionTestController({
			runTest,
			now: () => clock,
		});

		await controller.request(connection({ id: "a" }), "k");

		// Immediately after: refused, with the remainder reported.
		clock += 500;
		const refused = await controller.request(connection({ id: "a" }), "k");
		expect(refused.kind).toBe("refused");
		if (refused.kind === "refused" && refused.refusal.kind === "cooldown") {
			expect(refused.refusal.remainingMs).toBe(
				CONNECTION_TEST_COOLDOWN_MS - 500,
			);
		} else {
			throw new Error("expected a cooldown refusal");
		}
		expect(runTest).toHaveBeenCalledTimes(1);
	});

	it("allows a test once the cooldown has passed", async () => {
		let clock = 1_000_000;
		const runTest = vi.fn().mockResolvedValue(success);
		const controller = createConnectionTestController({
			runTest,
			now: () => clock,
		});

		await controller.request(connection({ id: "a" }), "k");
		clock += CONNECTION_TEST_COOLDOWN_MS;

		const outcome = await controller.request(connection({ id: "a" }), "k");
		expect(outcome.kind).toBe("result");
		expect(runTest).toHaveBeenCalledTimes(2);
	});

	it("starts the cooldown even when the test failed", async () => {
		const clock = 1_000_000;
		const failure: ConnectionTestResult = {
			ok: false,
			latencyMs: 5,
			attribution: { type: "auth_401", summary: "nope" },
		};
		const runTest = vi.fn().mockResolvedValue(failure);
		const controller = createConnectionTestController({
			runTest,
			now: () => clock,
		});

		await controller.request(connection({ id: "a" }), "k");
		const refused = await controller.request(connection({ id: "a" }), "k");

		// A failing endpoint must not be retried immediately either.
		expect(refused.kind).toBe("refused");
		expect(runTest).toHaveBeenCalledTimes(1);
	});
});

describe("connection test controller — abort on switch or delete", () => {
	it("aborts an in-flight test and does not surface its result", async () => {
		const gate = deferred<ConnectionTestResult>();
		const runTest = vi.fn().mockReturnValue(gate.promise);
		const controller = createConnectionTestController({ runTest });

		const pending = controller.request(connection({ id: "a" }), "k");
		expect(controller.running("a")).toBe(true);

		// The user switched away from this connection.
		controller.abort("a");

		gate.resolve(success);
		const outcome = await pending;

		// Nothing worth writing to a connection's status.
		expect(outcome.kind).toBe("refused");
		expect(controller.running("a")).toBe(false);
	});

	it("aborting one connection leaves another alone", async () => {
		const gateA = deferred<ConnectionTestResult>();
		const runTest = vi
			.fn()
			.mockImplementation((c: Connection) =>
				c.id === "a" ? gateA.promise : Promise.resolve(success),
			);
		const controller = createConnectionTestController({ runTest });

		const a = controller.request(connection({ id: "a" }), "k");
		const b = controller.request(connection({ id: "b" }), "k");

		controller.abort("a");
		gateA.resolve(success);

		await a;
		await expect(b).resolves.toEqual({ kind: "result", result: success });
	});

	it("abort with no argument cancels everything", async () => {
		const gate = deferred<ConnectionTestResult>();
		const runTest = vi.fn().mockReturnValue(gate.promise);
		const controller = createConnectionTestController({ runTest });

		const pending = controller.request(connection({ id: "a" }), "k");
		controller.abort();
		gate.resolve(success);

		await expect(pending).resolves.toMatchObject({ kind: "refused" });
	});
});

describe("connection test pacing — unchanged by the pre-flight check", () => {
	it("still enforces one flight per connection", async () => {
		const gate = deferred<ConnectionTestResult>();
		const runTest = vi.fn().mockReturnValue(gate.promise);
		const controller = createConnectionTestController({ runTest });

		const first = controller.request(connection({ id: "a" }), "k");
		const second = await controller.request(connection({ id: "a" }), "k");

		expect(second).toEqual({
			kind: "refused",
			refusal: { kind: "in-progress" },
		});

		gate.resolve(success);
		await first;
	});

	it("still applies the cooldown after a completed test", async () => {
		let now = 0;
		const runTest = vi.fn().mockResolvedValue(success);
		const controller = createConnectionTestController({
			runTest,
			now: () => now,
		});

		await controller.request(connection({ id: "a" }), "k");
		const blocked = await controller.request(connection({ id: "a" }), "k");

		expect(blocked).toEqual({
			kind: "refused",
			refusal: { kind: "cooldown", remainingMs: CONNECTION_TEST_COOLDOWN_MS },
		});

		now += CONNECTION_TEST_COOLDOWN_MS;
		await expect(
			controller.request(connection({ id: "a" }), "k"),
		).resolves.toMatchObject({ kind: "result" });
	});

	it("treats a pre-flight refusal as a completed test for pacing", async () => {
		// The controller measures cooldown from when a test *finishes*, and a
		// refusal finishes immediately. Documented here so the behaviour is a
		// decision rather than an accident: a refused test still counts, because
		// otherwise a user could hammer the button and re-run the same pre-flight
		// check in a tight loop for no benefit.
		const now = 0;
		const runTest = vi.fn().mockResolvedValue({
			ok: false,
			latencyMs: 0,
			attribution: { type: "mixed_content", summary: "blocked" },
		} satisfies ConnectionTestResult);
		const controller = createConnectionTestController({
			runTest,
			now: () => now,
		});

		await controller.request(connection({ id: "a" }), "k");
		const blocked = await controller.request(connection({ id: "a" }), "k");

		expect(blocked).toEqual({
			kind: "refused",
			refusal: { kind: "cooldown", remainingMs: CONNECTION_TEST_COOLDOWN_MS },
		});
		expect(runTest).toHaveBeenCalledTimes(1);
	});
});
