/**
 * Offline capability.
 *
 * Two separate concerns, kept in one small module because they answer the same
 * user question ("why can't I translate?"):
 *
 * 1. **Online state** — driven by the browser's connectivity events.
 * 2. **What that state permits** — a pure function over the state and a feature
 *    kind, so the rule is exhaustively testable without a DOM.
 *
 * The judgement is deliberately coarse. `navigator.onLine` reports whether the
 * device has a network interface, not whether a given endpoint is reachable. It is
 * therefore authoritative for "this feature needs a network at all" (disable it)
 * and explicitly **not** authoritative for "the model is usable" — a reachable
 * network with an unreachable model endpoint is a connection-test concern, handled
 * elsewhere.
 */

/** A feature's network requirement. */
export const FEATURE_KINDS = [
	/** Needs a model endpoint. */
	"translation",
	/** Needs to fetch a third-party page. */
	"webpage",
	/** Needs to list models from a provider. */
	"modelList",
	/** Local only: history, feedback, settings. */
	"localData",
] as const;

export type FeatureKind = (typeof FEATURE_KINDS)[number];

/** Features that cannot work without a network. */
const NETWORK_REQUIRED: readonly FeatureKind[] = [
	"translation",
	"webpage",
	"modelList",
];

/** Whether a feature requires a network at all. */
export function requiresNetwork(kind: FeatureKind): boolean {
	return NETWORK_REQUIRED.includes(kind);
}

/** Whether a feature is available in the current connectivity state. */
export function isFeatureAvailable(
	kind: FeatureKind,
	online: boolean,
): boolean {
	// Local features never become unavailable: browsing history offline is exactly
	// the case offline support exists for.
	return online || !requiresNetwork(kind);
}

/**
 * Explanation for a disabled feature.
 *
 * Distinguishes "offline" from every other cause, so a user does not go looking at
 * their model configuration when the real problem is a disconnected network.
 */
export function unavailableReason(
	kind: FeatureKind,
	online: boolean,
): string | undefined {
	if (isFeatureAvailable(kind, online)) return undefined;

	switch (kind) {
		case "translation":
			return "当前处于离线状态，无法发起翻译。连接网络或内网模型后即可使用。";
		case "webpage":
			return "当前处于离线状态，无法抓取网页内容。";
		case "modelList":
			return "当前处于离线状态，无法获取模型列表。";
		default:
			return undefined;
	}
}

/** Connectivity state holder. */
export interface ConnectivityState {
	online(): boolean;
	/** Subscribe to changes; returns an unsubscribe function. */
	subscribe(listener: (online: boolean) => void): () => void;
}

/** The browser's connectivity events, injectable for tests. */
export interface ConnectivityEnvironment {
	isOnline(): boolean;
	subscribe(listener: (online: boolean) => void): () => void;
}

/** Real environment, backed by `navigator.onLine` and the window events. */
export function createBrowserConnectivity(): ConnectivityEnvironment {
	return {
		isOnline: () =>
			typeof navigator === "undefined" ? true : navigator.onLine,
		subscribe: (listener) => {
			if (typeof window === "undefined") return () => {};

			const onOnline = () => listener(true);
			const onOffline = () => listener(false);

			window.addEventListener("online", onOnline);
			window.addEventListener("offline", onOffline);
			return () => {
				window.removeEventListener("online", onOnline);
				window.removeEventListener("offline", onOffline);
			};
		},
	};
}

/** Create a connectivity holder over an injectable environment. */
export function createConnectivityState(
	environment: ConnectivityEnvironment = createBrowserConnectivity(),
): ConnectivityState {
	return {
		online: () => environment.isOnline(),
		subscribe: (listener) => environment.subscribe(listener),
	};
}
