/**
 * Intranet pre-flight guidance for a connection's endpoint.
 *
 * A self-hosted model must satisfy two conditions the application cannot provide:
 * the endpoint has to serve **HTTPS** with a trusted certificate, and it has to
 * allow the application's origin. Explaining that before a test is run is more
 * useful than explaining it after a failure, because the failure arrives as an
 * opaque `TypeError` the browser refuses to explain.
 *
 * Kept as pure functions so the decision table can be verified without a browser,
 * and so the form and any future surface give the same answer.
 */

import type { ProviderId } from "#/lib/connections/model";
import { PROVIDER_PRESETS } from "#/lib/connections/presets";

/** What the guidance needs to know. */
export interface IntranetHintInput {
	readonly provider: ProviderId;
	/** The endpoint as currently typed. */
	readonly endpoint: string;
	/** The page's origin, or `undefined` when unavailable (prerender, tests). */
	readonly pageUrl?: string;
}

/**
 * Hosts that are reachable only from the local machine or a private network.
 *
 * These are self-hosted by definition: nothing about a public provider's CORS
 * posture applies to them.
 */
function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host === "::1" || host === "[::1]") return true;
	// RFC 1918 private ranges and the loopback / link-local blocks.
	if (/^127\./.test(host)) return true;
	if (/^10\./.test(host)) return true;
	if (/^192\.168\./.test(host)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
	if (/^169\.254\./.test(host)) return true;
	// Bare hostname with no dot (an intranet DNS name such as `model` or `gpu-01`).
	if (!host.includes(".") && host !== "") return true;
	return false;
}

/**
 * Hosts served by a *public* provider preset.
 *
 * The notice must stay off these, because their CORS posture is documented in the
 * compatibility list instead. Derived from the presets but **excluding** anything
 * on a local or private host: `ollama` is a built-in preset whose default endpoint
 * is `localhost`, and suppressing the guidance there would remove it from the case
 * that needs it most.
 */
const PUBLIC_PROVIDER_HOSTS: ReadonlySet<string> = new Set(
	PROVIDER_PRESETS.filter((preset) => preset.endpoint !== "")
		.map((preset) => {
			try {
				return new URL(preset.endpoint);
			} catch {
				return undefined;
			}
		})
		.filter((url): url is URL => url !== undefined)
		.filter((url) => !isLocalHost(url.hostname))
		.map((url) => url.host),
);

/**
 * Whether this endpoint is self-hosted and therefore needs the intranet conditions.
 *
 * True for a custom endpoint pointing at a machine the user runs (Ollama, vLLM,
 * LM Studio, a reverse proxy) — including `ollama`'s own preset, whose default
 * endpoint is localhost. False for the public providers, whose CORS posture is
 * documented in the compatibility list instead, and false for a same-origin
 * endpoint, which needs neither condition.
 */
export function needsIntranetConditions(input: IntranetHintInput): boolean {
	const endpoint = input.endpoint.trim();
	if (endpoint === "") return false;

	let target: URL;
	try {
		target = new URL(endpoint);
	} catch {
		// Still being typed: guidance would flicker on every keystroke.
		return false;
	}

	// A public provider host is reachable by design and documented elsewhere.
	if (PUBLIC_PROVIDER_HOSTS.has(target.host)) return false;

	const page = input.pageUrl;
	if (page === undefined) {
		// Without a page origin, cross-origin cannot be judged. Reporting the
		// conditions anyway is the safer default for a self-hosted endpoint.
		return true;
	}

	let origin: URL;
	try {
		origin = new URL(page);
	} catch {
		return true;
	}

	// Same origin (protocol, host and port all equal) needs neither condition.
	return target.origin !== origin.origin;
}

/** What the form should render for this endpoint. */
export interface IntranetHint {
	readonly show: boolean;
	/** Conditions the model side must satisfy, in the order they matter. */
	readonly conditions: readonly string[];
	/**
	 * The deployment-guide section holding the per-framework configuration.
	 *
	 * A section name rather than a URL: the guide is a repository file the
	 * application does not serve, so an in-app link would be a dead end.
	 */
	readonly docsSection: string;
}

/**
 * Section of `docs/deployment.md` holding the per-framework examples.
 *
 * Must match a heading in that file; a check asserts the two agree, so the
 * reference cannot drift into naming a section that does not exist.
 */
export const DEPLOYMENT_DOCS_SECTION =
	"Connection requirements for an intranet model";

/** Build the guidance for an endpoint. */
export function intranetHint(input: IntranetHintInput): IntranetHint {
	const show = needsIntranetConditions(input);

	return {
		show,
		conditions: [
			// HTTPS first: without it the request never leaves the browser, so CORS
			// never becomes the question.
			"模型端点需提供 HTTPS，且证书要被访问设备信任（浏览器会拦截 HTTPS 页面发往 http:// 端点的请求）。",
			"模型端点需放行本应用的来源（Origin）：请求是跨源的，浏览器会先发预检请求。",
			"两者缺一不可：只开 HTTPS 仍会被跨源拦截，只开来源放行仍会被混合内容拦截。",
		],
		docsSection: DEPLOYMENT_DOCS_SECTION,
	};
}
