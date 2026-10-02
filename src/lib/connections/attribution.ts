/**
 * Error attribution for model requests.
 *
 * Why this is a pure function: when a browser request fails, the browser tells
 * you almost nothing — a CORS rejection and an unreachable host both surface as
 * `TypeError: Failed to fetch`. The useful product behaviour is to convert that
 * silence into a small closed set of causes plus an actionable checklist. That
 * mapping is the one piece of this change worth testing exhaustively, so it
 * takes plain values in and returns plain values out.
 *
 * The enum matches PRD section 12.3's `error_type` values so the analytics
 * change can reuse it without a translation layer.
 *
 * Honesty constraint: because a browser does not expose the reason for a
 * blocked cross-origin request, the combined cause is reported as
 * `cors_or_network` and never as a definite "CORS misconfiguration".
 */

/** Closed set of failure causes. No free-text causes are allowed. */
export const ERROR_TYPES = [
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
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

/** Everything the attributor needs to classify a failed request. */
export interface FailureInput {
	/** HTTP status, when a response was actually received. */
	readonly httpStatus?: number;
	/** The thrown value, if the failure came from a rejection. */
	readonly error?: unknown;
	/** True when the request was aborted because the caller cancelled it. */
	readonly cancelledByUser?: boolean;
	/** True when the request was aborted because our own deadline elapsed. */
	readonly timedOut?: boolean;
	/** True when a response arrived with a successful status but unusable shape. */
	readonly malformedResponse?: boolean;
}

/** A classified failure plus the guidance to show the user. */
export interface FailureAttribution {
	readonly type: ErrorType;
	/** Short, non-alarming summary. */
	readonly summary: string;
	/** Concrete next steps. Present for causes the user can act on. */
	readonly checklist?: readonly string[];
}

/**
 * Fixed checklist for the combined CORS/network cause.
 *
 * Each item is something the user can actually check or change. Kept as
 * constant data so the UI cannot drift from the spec'd four items.
 */
export const CORS_CHECKLIST: readonly string[] = [
	"检查 Endpoint 是否写错，或缺少 `/v1` 一类的路径段。",
	"确认该服务商是否允许浏览器直连（对照设置页中的兼容性标注）。",
	"若使用 Ollama，确认启动时已设置允许来源（`OLLAMA_ORIGINS`）。",
	"确认没有被企业网络、代理或安全软件拦截。",
];

/** Message text per cause. Kept short; the checklist carries the detail. */
const SUMMARIES: Record<ErrorType, string> = {
	cors_or_network:
		"请求未能完成。浏览器不会说明具体原因，可能是跨域被拒，也可能是网络不可达。请按下列项排查。",
	dns: "域名无法解析，请检查 Endpoint 中的主机名是否拼写正确。",
	timeout: "请求超时。若使用内网自建模型，可能是模型冷启动，可稍后重试。",
	auth_401: "鉴权失败（401）。请检查该连接的 API Key 是否正确、是否已过期。",
	forbidden_403: "权限不足（403）。该 Key 可能没有访问此模型的权限。",
	not_found_404: "未找到（404）。请检查 Endpoint 路径与模型 ID 是否正确。",
	rate_limit_429: "请求过于频繁（429）。请稍后重试。",
	server_5xx: "服务端错误（5xx）。问题出在模型服务一侧，请稍后重试。",
	bad_response: "服务返回了无法解析的内容。该端点可能不兼容所选协议。",
	aborted: "请求已取消。",
	unknown: "请求失败，原因未知。",
};

/** Whether a status is in the 5xx range. */
function isServerError(status: number): boolean {
	return status >= 500 && status <= 599;
}

/**
 * Attribute a failure to one of the fixed causes.
 *
 * Order matters. Explicit signals (status codes, our own timeout flag, a user
 * cancellation, an unparsable body) are more informative than a generic
 * rejection, so they are checked first.
 */
export function attributeFailure(input: FailureInput): FailureAttribution {
	const { httpStatus, cancelledByUser, timedOut, malformedResponse } = input;

	// A user cancellation is never an error condition worth diagnosing.
	if (cancelledByUser) {
		return { type: "aborted", summary: SUMMARIES.aborted };
	}

	// Our own deadline elapsed: we know the cause without asking the browser.
	if (timedOut) {
		return { type: "timeout", summary: SUMMARIES.timeout };
	}

	// A response arrived but its body was not usable.
	if (malformedResponse) {
		return { type: "bad_response", summary: SUMMARIES.bad_response };
	}

	if (typeof httpStatus === "number") {
		if (httpStatus === 401)
			return { type: "auth_401", summary: SUMMARIES.auth_401 };
		if (httpStatus === 403)
			return { type: "forbidden_403", summary: SUMMARIES.forbidden_403 };
		if (httpStatus === 404)
			return { type: "not_found_404", summary: SUMMARIES.not_found_404 };
		if (httpStatus === 429)
			return { type: "rate_limit_429", summary: SUMMARIES.rate_limit_429 };
		if (isServerError(httpStatus))
			return { type: "server_5xx", summary: SUMMARIES.server_5xx };

		// Any other non-2xx status has no dedicated cause in the enum.
		if (httpStatus < 200 || httpStatus >= 300) {
			return { type: "unknown", summary: `请求返回了状态码 ${httpStatus}。` };
		}
	}

	const error = input.error;
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error ?? "");

	// A fetch that never produced a response is indistinguishable between a
	// blocked cross-origin request and an unreachable host. Report the combined
	// cause and let the checklist cover both.
	if (
		name === "TypeError" ||
		/failed to fetch|networkerror|load failed|network request failed/i.test(
			message,
		)
	) {
		return {
			type: "cors_or_network",
			summary: SUMMARIES.cors_or_network,
			checklist: CORS_CHECKLIST,
		};
	}

	if (/enotfound|name not resolved|getaddrinfo|dns/i.test(message)) {
		return { type: "dns", summary: SUMMARIES.dns };
	}

	// A caller-initiated abort that is not our timeout and not attributed to the
	// user by the caller: report as aborted rather than as a network failure.
	if (name === "AbortError") {
		return { type: "aborted", summary: SUMMARIES.aborted };
	}

	return { type: "unknown", summary: SUMMARIES.unknown };
}

/** The checklist to show alongside a cause, if any. */
export function checklistFor(type: ErrorType): readonly string[] | undefined {
	return type === "cors_or_network" ? CORS_CHECKLIST : undefined;
}
