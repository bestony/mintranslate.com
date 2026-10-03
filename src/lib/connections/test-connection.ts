/**
 * Connection test.
 *
 * Sends one minimal real request through the same adapter the application uses
 * for translation, so a passing test means the actual call path works — not
 * that some simpler probe endpoint responded (design.md D7).
 *
 * The test is bounded by an `AbortController` deadline. The PRD requires a
 * conclusion within 10 seconds, so the deadline is reported as its own cause
 * rather than being left for the browser to fail eventually.
 */

import { chat } from "@tanstack/ai";

import { parseRetryAfter } from "../call-control/backoff";
import { scrubSecrets } from "../credentials/redact";
import { logger } from "../logger";
import { createAdapterForConnection, probeModelOptions } from "./adapters";
import {
	attributeFailure,
	type FailureAttribution,
	preflightMixedContent,
} from "./attribution";
import { bodyOf, retryAfterOf, statusOf } from "./error-shape";
import type { Connection } from "./model";

/** Deadline for a connection test, in milliseconds. */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;

/**
 * Output cap for the probe request.
 *
 * One token keeps the probe as close to free as possible while still exercising
 * auth, routing and response parsing. Resolved from design.md Open Question 2.
 */
const PROBE_MAX_OUTPUT_TOKENS = 1;

/** Outcome of a connection test. */
export type ConnectionTestResult =
	| {
			readonly ok: true;
			readonly latencyMs: number;
	  }
	| {
			readonly ok: false;
			readonly latencyMs: number;
			readonly attribution: FailureAttribution;
			/** Already-redacted status code and body fragment, for diagnosis. */
			readonly diagnostic?: string;
			/**
			 * Suggested wait before retrying, parsed from `Retry-After`.
			 *
			 * Carried on the result so the UI can show a concrete wait instead of
			 * re-parsing response headers (spec `connection-test`).
			 */
			readonly suggestedWaitMs?: number;
	  };

/**
 * Build a diagnostic string that is safe to display.
 *
 * Redaction goes through `scrubSecrets` — the single masking implementation —
 * and happens before truncation: cutting first could slice a key in half and
 * leave a fragment that no longer matches the full string, so it would survive
 * into the output.
 */
function buildDiagnostic(
	status: number | undefined,
	body: string,
	apiKey: string,
): string {
	const redacted = scrubSecrets(body, apiKey.trim() === "" ? [] : [apiKey]);
	const fragment =
		redacted.length > 400 ? `${redacted.slice(0, 400)}…` : redacted;
	const statusPart = status === undefined ? "" : `HTTP ${status} — `;
	return `${statusPart}${fragment}`.trim();
}

/**
 * Test a connection.
 *
 * `timeoutMs` is injectable so tests do not have to wait the full deadline.
 */
export async function testConnection(
	connection: Connection,
	apiKey: string,
	options: { readonly timeoutMs?: number } = {},
): Promise<ConnectionTestResult> {
	const timeoutMs = options.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS;
	const controller = new AbortController();
	const startedAt = Date.now();

	logger.info("connection.test.start", {
		connectionId: connection.id,
		provider: connection.provider,
		model: connection.model,
	});

	// Decide before spending a request. A mixed-content refusal is guaranteed, and
	// the error the browser would raise is indistinguishable from a CORS rejection
	// or an unreachable host — so the only way to report the real cause is to ask
	// first. This path is shared with the workspace through the same predicate, so
	// both give the same verdict (spec `intranet-connectivity`).
	const blocked = preflightMixedContent({
		isSecureContext: globalThis.isSecureContext === true,
		pageUrl: typeof location === "undefined" ? undefined : location.href,
		endpoint: connection.endpoint,
	});
	if (blocked !== undefined) {
		const latencyMs = Date.now() - startedAt;
		logger.warn("connection.test.blocked", {
			connectionId: connection.id,
			endpoint: connection.endpoint,
			reason: "mixed_content",
		});
		return {
			ok: false,
			latencyMs,
			attribution: blocked,
		};
	}

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		const adapter = await createAdapterForConnection(connection, apiKey);

		// A non-streaming call returns the collected text. Streaming is not
		// needed to prove connectivity, and not collecting a stream keeps this
		// path free of event-shape handling.
		await chat({
			adapter,
			messages: [{ role: "user", content: "ping" }],
			stream: false,
			modelOptions: probeModelOptions(
				connection.provider,
				PROBE_MAX_OUTPUT_TOKENS,
			),
			abortController: controller,
		} as Parameters<typeof chat>[0]);

		const latencyMs = Date.now() - startedAt;
		logger.info("connection.test.success", {
			connectionId: connection.id,
			provider: connection.provider,
			model: connection.model,
			latencyMs,
		});

		return { ok: true, latencyMs };
	} catch (error) {
		const status = statusOf(error);

		const attribution = attributeFailure({
			httpStatus: status,
			error,
			timedOut,
			// The caller never cancels a connection test, so an abort here is
			// always the deadline, which is its own cause.
			cancelledByUser: false,
		});

		const diagnostic = buildDiagnostic(status, bodyOf(error), apiKey);

		// Only a rate-limit response carries a meaningful wait; parsing the header
		// for other statuses would invent a delay the endpoint never asked for.
		const suggestedWaitMs =
			attribution.type === "rate_limit_429"
				? parseRetryAfter(retryAfterOf(error))
				: undefined;

		const latencyMs = Date.now() - startedAt;
		logger.warn("connection.test.failed", {
			connectionId: connection.id,
			provider: connection.provider,
			model: connection.model,
			latencyMs,
			status,
			attributionType: attribution.type,
			diagnostic,
		});

		return {
			ok: false,
			latencyMs,
			attribution,
			...(diagnostic !== "" && { diagnostic }),
			...(suggestedWaitMs !== undefined && { suggestedWaitMs }),
		};
	} finally {
		clearTimeout(timer);
	}
}
