/**
 * Translation call entry point.
 *
 * This is the single place a caller should use to talk to a model. It composes
 * everything this change established:
 *
 * - the capability guard, so an unsuitable connection is refused **before** a
 *   request is sent;
 * - the per-connection concurrency limiter, so one endpoint is not flooded;
 * - latest-wins cancellation, so a superseded call is aborted and its late
 *   result never returned;
 * - the connection-level single-flight for the same request key.
 *
 * `core-translation` is expected to build "translate as you type" on top of
 * this, adding only its own debounce and composition handling. It must not
 * re-implement concurrency, cancellation or capability checks.
 */

import { chat } from "@tanstack/ai";

import type { ConcurrencyLimiter } from "../call-control/concurrency";
import { createLatestCall } from "../call-control/latest-call";
import { createSingleFlightWithState } from "../call-control/single-flight";
import { createAdapterForConnection } from "./adapters";
import { type CallRequirement, capabilityBlocker } from "./capability-guard";
import type { Connection } from "./model";

/** What a caller supplies for one model call. */
export interface ModelCallRequest {
	readonly connection: Connection;
	readonly apiKey: string;
	/** What the call needs from the connection. */
	readonly requirement: CallRequirement;
	readonly systemInstruction?: string;
	readonly userContent: string;
	/** Stream partial text as it arrives. */
	readonly onChunk?: (text: string) => void;
}

/** Why a call did not produce a result. */
export type ModelCallRefusal =
	| { readonly kind: "capability"; readonly reason: string }
	/** A newer call for the same connection took over. */
	| { readonly kind: "superseded" };

/** Outcome of a model call. */
export type ModelCallOutcome =
	| { readonly kind: "result"; readonly text: string }
	| { readonly kind: "refused"; readonly refusal: ModelCallRefusal };

/** Call surface exposed to the rest of the application. */
export interface ModelCaller {
	call(request: ModelCallRequest): Promise<ModelCallOutcome>;
	/** Abort the in-flight call for a connection, as a user cancellation. */
	cancel(connectionId: string): void;
	/** Whether a call is in flight for a connection. */
	busy(connectionId: string): boolean;
}

/** Executes one request. Injectable so orchestration is testable without a network. */
export type ModelTransport = (
	request: ModelCallRequest,
	signal: AbortSignal,
) => Promise<string>;

/** What the caller needs from the surrounding application. */
export interface ModelCallerDeps {
	/**
	 * Per-connection limiter lookup. Supplied by the caller so limits are shared
	 * across every component that talks to the same connection.
	 */
	readonly limiterFor: (connectionId: string) => ConcurrencyLimiter;
	/**
	 * Transport used to perform the request. Defaults to the real provider path;
	 * tests substitute it so no request leaves the process.
	 */
	readonly transport?: ModelTransport;
}

/** Create the caller. */
export function createModelCaller(deps: ModelCallerDeps): ModelCaller {
	const transport = deps.transport ?? performCall;
	const latestPerConnection = new Map<
		string,
		ReturnType<typeof createLatestCall>
	>();
	const singleFlight = createSingleFlightWithState<string, string>();

	function latestFor(connectionId: string) {
		const existing = latestPerConnection.get(connectionId);
		if (existing) return existing;

		const created = createLatestCall();
		latestPerConnection.set(connectionId, created);
		return created;
	}

	return {
		async call(request) {
			const { connection } = request;

			// Refuse before doing anything else: an unsuitable connection must
			// never produce a request (spec `provider-connections`).
			const blocker = capabilityBlocker(connection, request.requirement);
			if (blocker !== undefined) {
				return {
					kind: "refused",
					refusal: { kind: "capability", reason: blocker },
				};
			}

			const latest = latestFor(connection.id);

			// The flight key includes content, so two different texts are two
			// different requests while genuinely identical ones share a flight.
			const flightKey = `${connection.id}:${request.requirement}:${request.userContent}`;

			// Identical request already in flight: join it instead of superseding
			// it. Superseding would cancel a call that would have produced exactly
			// the same answer, turning a harmless duplicate into a wasted request.
			if (singleFlight.has(flightKey)) {
				const joined = await singleFlight.run(flightKey, () =>
					transport(request, new AbortController().signal),
				);
				return { kind: "result", text: joined };
			}

			const outcome = await latest.run(async (signal) =>
				deps.limiterFor(connection.id).run(
					() => singleFlight.run(flightKey, () => transport(request, signal)),
					// Consulted when a slot is granted, so a queued call that was
					// superseded never sends a request.
					() => latest.busy(),
				),
			);

			if (outcome.kind === "superseded") {
				return { kind: "refused", refusal: { kind: "superseded" } };
			}

			const slot = outcome.value;
			if (slot.kind === "superseded") {
				return { kind: "refused", refusal: { kind: "superseded" } };
			}

			return { kind: "result", text: slot.value };
		},

		cancel(connectionId) {
			latestPerConnection.get(connectionId)?.cancel();
		},

		busy(connectionId) {
			return latestPerConnection.get(connectionId)?.busy() ?? false;
		},
	};
}

/** Execute one request, aborting with the provided signal. */
async function performCall(
	request: ModelCallRequest,
	signal: AbortSignal,
): Promise<string> {
	const adapter = await createAdapterForConnection(
		request.connection,
		request.apiKey,
	);

	const messages: Array<{ role: "system" | "user"; content: string }> = [];
	if (
		request.systemInstruction !== undefined &&
		request.systemInstruction !== ""
	) {
		messages.push({ role: "system", content: request.systemInstruction });
	}
	messages.push({ role: "user", content: request.userContent });

	if (request.onChunk) {
		const stream = chat({
			adapter,
			messages,
			abortController: createAbortControllerFrom(signal),
		} as Parameters<typeof chat>[0]);

		let collected = "";
		for await (const event of stream as AsyncIterable<{
			type?: string;
			delta?: string;
		}>) {
			const delta = event?.delta;
			if (typeof delta === "string" && delta !== "") {
				collected += delta;
				request.onChunk(delta);
			}
		}
		return collected;
	}

	const text = await chat({
		adapter,
		messages,
		stream: false,
		abortController: createAbortControllerFrom(signal),
	} as Parameters<typeof chat>[0]);

	return typeof text === "string" ? text : "";
}

/**
 * Adapt an `AbortSignal` to the `AbortController` the AI layer expects.
 *
 * The API takes a controller rather than a signal, so an already-aborted signal
 * must be replayed onto the new controller — otherwise the abort would be lost.
 */
function createAbortControllerFrom(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort();
	else
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	return controller;
}
