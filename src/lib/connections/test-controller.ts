/**
 * Connection-test controller.
 *
 * Wraps `testConnection` with the call-control rules the settings UI needs:
 *
 * - one test per connection at a time (single-flight), so double-clicking the
 *   button cannot send two probes;
 * - a minimum cooldown after a test finishes, so a user cannot hammer a paid
 *   endpoint by clicking repeatedly;
 * - aborting an in-flight test when the user switches or deletes the
 *   connection, so a stale result is never written onto a different connection.
 *
 * Kept separate from `testConnection` so the transport logic stays free of UI
 * pacing concerns, and so the pacing rules are testable without a network.
 */

import { createLatestCall } from "../call-control/latest-call";
import { createSingleFlight } from "../call-control/single-flight";
import type { Connection } from "./model";
import { type ConnectionTestResult, testConnection } from "./test-connection";

/** Minimum wait between two tests of the same connection. */
export const CONNECTION_TEST_COOLDOWN_MS = 2000;

/** Why a test request was refused before any network call. */
export type TestRefusal =
	| { readonly kind: "in-progress" }
	| { readonly kind: "cooldown"; readonly remainingMs: number };

/** Outcome of asking for a test. */
export type TestRequestOutcome =
	| { readonly kind: "result"; readonly result: ConnectionTestResult }
	| { readonly kind: "refused"; readonly refusal: TestRefusal };

/** Injectable clock so the cooldown can be tested without waiting. */
export interface TestControllerDeps {
	readonly now?: () => number;
	readonly timeoutMs?: number;
	/** Tests the transport layer directly. Defaults to the real implementation. */
	readonly runTest?: (
		connection: Connection,
		apiKey: string,
	) => Promise<ConnectionTestResult>;
}

/** Per-connection test pacing controller. */
export interface ConnectionTestController {
	/** Run a test unless it is refused by pacing. */
	request(connection: Connection, apiKey: string): Promise<TestRequestOutcome>;
	/** Abort an in-flight test, e.g. because the connection changed. */
	abort(connectionId?: string): void;
	/** Whether a test is currently in flight for a connection. */
	running(connectionId: string): boolean;
}

/** Create a controller. */
export function createConnectionTestController(
	deps: TestControllerDeps = {},
): ConnectionTestController {
	const now = deps.now ?? (() => Date.now());
	const runTest =
		deps.runTest ??
		((connection: Connection, apiKey: string) =>
			testConnection(connection, apiKey, { timeoutMs: deps.timeoutMs }));

	/** One flight per connection id. */
	const flight = createSingleFlight<string, ConnectionTestResult>();
	/** Latest-wins per connection, so a new test aborts the old one. */
	const latestPerConnection = new Map<
		string,
		ReturnType<typeof createLatestCall>
	>();
	/** Timestamp when each connection last finished a test. */
	const finishedAt = new Map<string, number>();

	function latestFor(connectionId: string) {
		const existing = latestPerConnection.get(connectionId);
		if (existing) return existing;

		const created = createLatestCall();
		latestPerConnection.set(connectionId, created);
		return created;
	}

	return {
		async request(connection, apiKey) {
			const id = connection.id;

			// An in-flight test already covers this connection: report it rather
			// than starting a second probe.
			if (latestFor(id).busy()) {
				return { kind: "refused", refusal: { kind: "in-progress" } };
			}

			// Cooldown is measured from when the previous test finished.
			const last = finishedAt.get(id);
			if (last !== undefined) {
				const elapsed = now() - last;
				if (elapsed < CONNECTION_TEST_COOLDOWN_MS) {
					return {
						kind: "refused",
						refusal: {
							kind: "cooldown",
							remainingMs: CONNECTION_TEST_COOLDOWN_MS - elapsed,
						},
					};
				}
			}

			const outcome = await latestFor(id).run(() =>
				flight(id, () => runTest(connection, apiKey)),
			);

			// Record completion for the cooldown, whether or not it succeeded.
			finishedAt.set(id, now());

			if (outcome.kind === "superseded") {
				// A newer test took over; this one produced nothing worth showing.
				return { kind: "refused", refusal: { kind: "in-progress" } };
			}

			return { kind: "result", result: outcome.value };
		},

		abort(connectionId) {
			if (connectionId === undefined) {
				for (const latest of latestPerConnection.values()) latest.cancel();
				return;
			}
			latestPerConnection.get(connectionId)?.cancel();
		},

		running(connectionId) {
			return latestPerConnection.get(connectionId)?.busy() ?? false;
		},
	};
}
