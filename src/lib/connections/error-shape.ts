/**
 * Reading the error shapes providers actually throw.
 *
 * Lives here rather than beside either caller because both the connection test
 * and the image pipeline need the same three facts — a status code, a
 * `Retry-After` value, a body fragment — and each provider SDK exposes them
 * differently. One implementation means a new SDK quirk is fixed once.
 */

/**
 * Pull a `Retry-After` header value out of an SDK error, if the response
 * carried one. Headers may be a `Headers` instance or a plain object.
 */
export function retryAfterOf(error: unknown): string | undefined {
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
export function statusOf(error: unknown): number | undefined {
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
export function bodyOf(error: unknown): string {
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
