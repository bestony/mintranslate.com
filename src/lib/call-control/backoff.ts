/**
 * Rate-limit backoff.
 *
 * A 429 is the endpoint telling us to slow down. The response often carries
 * `Retry-After`, which is strictly better information than any local guess, so
 * it is preferred when present. Automatic retry is capped at one attempt by
 * default: retrying harder against a rate limit makes the limit worse, and the
 * cap is configurable so a caller can turn it off entirely.
 */

/** Backoff policy. */
export interface BackoffPolicy {
	/** Maximum automatic retries. `0` disables retrying. Default 1. */
	readonly maxRetries?: number;
	/** Base delay for the exponential step, in ms. Default 1000. */
	readonly baseDelayMs?: number;
}

/** Resolved policy with defaults applied. */
export interface ResolvedBackoffPolicy {
	readonly maxRetries: number;
	readonly baseDelayMs: number;
}

export const DEFAULT_BACKOFF_POLICY: ResolvedBackoffPolicy = {
	maxRetries: 1,
	baseDelayMs: 1000,
};

/** Resolve a policy, applying defaults. */
export function resolveBackoffPolicy(
	policy: BackoffPolicy = {},
): ResolvedBackoffPolicy {
	return {
		maxRetries: Math.max(
			0,
			policy.maxRetries ?? DEFAULT_BACKOFF_POLICY.maxRetries,
		),
		baseDelayMs: Math.max(
			0,
			policy.baseDelayMs ?? DEFAULT_BACKOFF_POLICY.baseDelayMs,
		),
	};
}

/** Whether a status is the rate-limit signal. */
export function isRateLimited(status: number | undefined): boolean {
	return status === 429;
}

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * The header is either a number of seconds or an HTTP date. Returns `undefined`
 * for anything unparsable or negative, so the caller falls back to its own
 * delay instead of waiting on nonsense.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	now = Date.now(),
): number | undefined {
	if (value === null || value === undefined) return undefined;

	const trimmed = value.trim();
	if (trimmed === "") return undefined;

	// Delay-seconds form.
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isFinite(seconds) ? seconds * 1000 : undefined;
	}

	// HTTP-date form. `Date.parse` rejects nonsense by returning NaN.
	const timestamp = Date.parse(trimmed);
	if (Number.isNaN(timestamp)) return undefined;

	const delta = timestamp - now;
	return delta > 0 ? delta : undefined;
}

/**
 * Delay to wait before retry attempt `attempt` (1-based) for a rate-limited
 * response.
 *
 * `Retry-After` wins when present because the endpoint knows its own refill
 * schedule. Otherwise the delay grows exponentially with the attempt.
 */
export function rateLimitDelayMs(options: {
	readonly attempt: number;
	readonly retryAfter?: number;
	readonly policy?: ResolvedBackoffPolicy;
}): number {
	const policy = options.policy ?? DEFAULT_BACKOFF_POLICY;

	if (options.retryAfter !== undefined && options.retryAfter > 0)
		return options.retryAfter;

	// Exponential: base, then base * 2, capped by the attempt count so the value
	// stays finite for large attempt numbers.
	const exponent = Math.min(options.attempt - 1, 8);
	return policy.baseDelayMs * 2 ** exponent;
}

/** What to do after a rate-limited response. */
export type RetryDecision =
	| { readonly kind: "retry"; readonly waitMs: number }
	| {
			readonly kind: "give-up";
			readonly waitMs: number;
			readonly reason: string;
	  };

/**
 * Decide whether to retry after a 429.
 *
 * `attemptsSoFar` counts attempts already made, so `0` means the first failure.
 */
export function decideRetry(options: {
	readonly attemptsSoFar: number;
	readonly retryAfter?: number;
	readonly policy?: BackoffPolicy;
}): RetryDecision {
	const policy = resolveBackoffPolicy(options.policy);
	const waitMs = rateLimitDelayMs({
		attempt: options.attemptsSoFar + 1,
		retryAfter: options.retryAfter,
		policy,
	});

	if (options.attemptsSoFar >= policy.maxRetries) {
		return {
			kind: "give-up",
			waitMs,
			reason:
				policy.maxRetries === 0
					? "已禁用自动重试"
					: `已达到自动重试上限（${policy.maxRetries} 次）`,
		};
	}

	return { kind: "retry", waitMs };
}

/** Human-readable wait hint for the UI. */
export function describeWait(waitMs: number): string {
	const seconds = Math.ceil(waitMs / 1000);
	return `请求过于频繁，建议等待约 ${seconds} 秒后重试。`;
}
