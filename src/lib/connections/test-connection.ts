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
import { createAdapterForConnection, probeModelOptions } from "./adapters";
import { attributeFailure, type FailureAttribution } from "./attribution";
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
 * Pull a `Retry-After` header value out of an SDK error, if the response
 * carried one. Headers may be a `Headers` instance or a plain object.
 */
function retryAfterOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const candidate = error as { headers?: unknown; response?: unknown };

	const readFrom = (source: unknown): string | undefined => {
		if (!source || typeof source !== "object") return undefined;
		const headers = source as {
			get?: (name: string) => string | null;
			"retry-after"?: unknown;
			retryAfter?: unknown;
		};

		if (typeof headers.get === "function") {
			const value = headers.get("retry-after");
			if (typeof value === "string") return value;
		}
		if (typeof headers["retry-after"] === "string")
			return headers["retry-after"];
		if (typeof headers.retryAfter === "string") return headers.retryAfter;
		return undefined;
	};

	return readFrom(candidate.headers) ?? readFrom(candidate.response);
}

/** Pull a status code out of whatever an SDK error exposes. */
function statusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const candidate = error as {
		status?: unknown;
		statusCode?: unknown;
		response?: unknown;
	};

	if (typeof candidate.status === "number") return candidate.status;
	if (typeof candidate.statusCode === "number") return candidate.statusCode;

	const response = candidate.response as { status?: unknown } | undefined;
	if (response && typeof response.status === "number") return response.status;

	return undefined;
}

/** Pull a response body fragment out of an SDK error, if it carries one. */
function bodyOf(error: unknown): string {
	if (typeof error !== "object" || error === null) return "";
	const candidate = error as {
		error?: unknown;
		message?: unknown;
		body?: unknown;
	};

	if (typeof candidate.body === "string") return candidate.body;
	if (candidate.body !== undefined) {
		try {
			return JSON.stringify(candidate.body);
		} catch {
			// Fall through to the message.
		}
	}

	if (candidate.error !== undefined) {
		try {
			return JSON.stringify(candidate.error);
		} catch {
			// Fall through to the message.
		}
	}

	return typeof candidate.message === "string" ? candidate.message : "";
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

		return { ok: true, latencyMs: Date.now() - startedAt };
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

		return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			attribution,
			...(diagnostic !== "" && { diagnostic }),
			...(suggestedWaitMs !== undefined && { suggestedWaitMs }),
		};
	} finally {
		clearTimeout(timer);
	}
}
