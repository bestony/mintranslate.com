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

import { logger } from "../logger";

/**
 * Where attribution events go.
 *
 * Injectable so the mapping can be tested without capturing global output, and so
 * callers that already have structured reporting can redirect it. Attribution is
 * the only place that knows the classified cause, which is why the event is emitted
 * here rather than at each call site.
 */
export interface AttributionSink {
	debug(event: string, fields: Record<string, unknown>): void;
}

/** Default sink: the shared logger, which already redacts and thresholds. */
const defaultSink: AttributionSink = {
	debug: (event, fields) => logger.debug(event, fields),
};

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
	// Appended for intranet deployments. Existing members keep their names and
	// positions: the enum is the analytics `error_type` contract, so renaming or
	// reordering would break comparability with already-reported data.
	"mixed_content",
	"certificate",
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
	// The original four, kept verbatim: they cover the public-provider case.
	"检查 Endpoint 是否写错，或缺少 `/v1` 一类的路径段。",
	"确认该服务商是否允许浏览器直连（对照设置页中的兼容性标注）。",
	"若使用 Ollama，确认启动时已设置允许来源（`OLLAMA_ORIGINS`）。",
	"确认没有被企业网络、代理或安全软件拦截。",
	// Added for intranet self-hosted models, where the browser gives no reason and
	// these two causes are at least as common as the four above. Directory the
	// deployment guide for the per-framework configuration.
	"若为内网自建模型，确认模型侧已放行本应用的来源（Origin）——各框架的配置方式见部署文档。",
	"若为内网自建模型，确认端点证书由客户端信任的 CA 签发：证书不受信任时浏览器同样只报一个通用网络错误。",
];

/**
 * Checklist for a request blocked by the mixed-content rules.
 *
 * Every item is a model-side action, because this failure is never the client's
 * to fix: the browser refuses an `http://` endpoint from an `https://` page, and
 * only the endpoint can supply HTTPS.
 */
export const MIXED_CONTENT_CHECKLIST: readonly string[] = [
	"为模型端点启用 HTTPS。浏览器会拦截从 HTTPS 页面发往 http:// 端点的请求，这不取决于模型框架。",
	"确认证书由客户端信任的 CA 签发（自签证书需导入到访问设备的信任库）。",
	"若模型只能监听明文 HTTP，请在其前面加一层提供 HTTPS 的入口，使浏览器实际访问的是 https:// 地址。",
];

/**
 * Checklist for a suspected certificate problem.
 *
 * Only offered when a readable signal pointed at the certificate. The wording
 * lists what to verify rather than asserting a cause, because a browser normally
 * cannot confirm it (see design D1).
 */
export const CERTIFICATE_CHECKLIST: readonly string[] = [
	"确认端点证书未被浏览器拒绝：直接在地址栏打开端点地址，观察是否出现证书警告。",
	"确认证书的主机名与 Endpoint 中填写的主机名一致。",
	"确认签发该证书的 CA 已被访问设备信任（自签或内网 CA 需要显式导入）。",
	"确认证书未过期。",
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
	mixed_content:
		"请求被浏览器的混合内容规则拦截：页面以 HTTPS 打开，而端点不是 HTTPS。请为模型侧启用 HTTPS（证书需被客户端信任）。",
	// Reported only with a readable signal. Without one the failure is attributed
	// to `cors_or_network` instead — see `attributeFailure` and design D1.
	certificate:
		"疑似证书问题：浏览器未能验证端点证书。请确认证书由客户端信任的 CA 签发、且主机名与证书匹配。",
};

/** Whether a status is in the 5xx range. */
function isServerError(status: number): boolean {
	return status >= 500 && status <= 599;
}

/** What the pre-flight check needs to know about the environment. */
export interface MixedContentInput {
	/** Whether the page runs in a secure context (HTTPS, or the localhost exemption). */
	readonly isSecureContext: boolean;
	/** The page's own URL, or `undefined` when unknown (prerender, tests). */
	readonly pageUrl?: string;
	/** The endpoint the user configured. */
	readonly endpoint: string;
}

/**
 * Whether a request to this endpoint is guaranteed to be blocked as mixed content.
 *
 * Checked before the request rather than after it fails, for two reasons: the
 * browser would refuse it anyway, and the error it produces (`TypeError: Failed to
 * fetch`) is indistinguishable from a CORS rejection or an unreachable host. Asking
 * first is the only way to report the real cause.
 *
 * The test is "page is secure **and** the endpoint is not `https:`", not
 * "endpoint is `http:`". Enumerating `http:` would miss other plaintext schemes
 * (`ws:`), which the browser blocks for the same reason.
 *
 * Returns the attribution to report, or `undefined` when the request may proceed.
 */
export function preflightMixedContent(
	input: MixedContentInput,
	sink: AttributionSink = defaultSink,
): FailureAttribution | undefined {
	const startedAt = Date.now();
	const blocked = evaluateMixedContent(input);

	if (blocked) {
		// Recorded because this is the one failure detected *before* the request:
		// its absence from a network log is expected, not evidence of a bug.
		sink.debug("connection.attribution", {
			cause: blocked.type,
			preflight: true,
			signal: "protocol",
			checklist: true,
			elapsedMs: Date.now() - startedAt,
		});
	}

	return blocked;
}

/** The pre-flight decision itself, separated so the caller can log around it. */
function evaluateMixedContent(
	input: MixedContentInput,
): FailureAttribution | undefined {
	if (!input.isSecureContext) return undefined;

	let endpoint: URL;
	try {
		endpoint = new URL(input.endpoint);
	} catch {
		// An unparsable endpoint is a different failure, reported by the caller.
		return undefined;
	}

	if (endpoint.protocol === "https:") return undefined;

	// Same-origin is impossible here only in theory; a plaintext same-origin
	// endpoint would still be blocked, so no exemption is needed.
	return {
		type: "mixed_content",
		summary: SUMMARIES.mixed_content,
		checklist: MIXED_CONTENT_CHECKLIST,
	};
}

/**
 * Attribute a failure to one of the fixed causes.
 *
 * Order matters. Explicit signals (status codes, our own timeout flag, a user
 * cancellation, an unparsable body) are more informative than a generic
 * rejection, so they are checked first.
 */
export function attributeFailure(
	input: FailureInput,
	sink: AttributionSink = defaultSink,
): FailureAttribution {
	const startedAt = Date.now();
	const attribution = classify(input);

	// One event per attribution, carrying the classified cause. Never the message
	// or any credential: the cause is what diagnostics need, and the raw text can
	// contain a key echoed back by a gateway.
	sink.debug("connection.attribution", {
		cause: attribution.type,
		preflight: false,
		// Distinguishes a status-code verdict from an inferred one, which is the
		// difference between "we know" and "we guessed".
		signal: typeof input.httpStatus === "number" ? "http_status" : "exception",
		checklist: attribution.checklist !== undefined,
		elapsedMs: Date.now() - startedAt,
	});

	return attribution;
}

/** The classification itself, separated so the caller can log around it. */
function classify(input: FailureInput): FailureAttribution {
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

	// A certificate failure is reported only when the error text actually names
	// one. Browsers normally fold it into the same opaque "Failed to fetch" as a
	// CORS rejection, and claiming a certificate cause there would be a guess —
	// the checklist for `cors_or_network` covers the possibility instead.
	if (/certificate|self.signed|ssl|tls|err_cert/i.test(message)) {
		return {
			type: "certificate",
			summary: SUMMARIES.certificate,
			checklist: CERTIFICATE_CHECKLIST,
		};
	}

	// A caller-initiated abort that is not our timeout and not attributed to the
	// user by the caller: report as aborted rather than as a network failure.
	if (name === "AbortError") {
		return { type: "aborted", summary: SUMMARIES.aborted };
	}

	return { type: "unknown", summary: SUMMARIES.unknown };
}

/**
 * The checklist to show alongside a cause, if any.
 *
 * Dispatched by cause rather than returning a single list, so a cause that has
 * specific guidance shows that guidance instead of the generic four items.
 */
export function checklistFor(type: ErrorType): readonly string[] | undefined {
	switch (type) {
		case "cors_or_network":
			return CORS_CHECKLIST;
		case "mixed_content":
			return MIXED_CONTENT_CHECKLIST;
		case "certificate":
			return CERTIFICATE_CHECKLIST;
		default:
			return undefined;
	}
}
