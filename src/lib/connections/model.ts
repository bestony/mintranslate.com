/**
 * Connection configuration model.
 *
 * A connection is one endpoint the user has configured: which provider it
 * belongs to, where it points, which model to use, what it can do, and whether
 * it has been proven to work.
 *
 * The API key is deliberately NOT part of this type. Keys live in a separate
 * store (see `credentials.ts`) so that exporting a connection can never leak a
 * key by omission or by a filtering bug.
 */

/**
 * Provider identifiers.
 *
 * `custom` covers any OpenAI-compatible gateway or self-hosted service. The
 * set is intentionally closed: an unknown provider id cannot be routed to an
 * adapter, so it must be rejected at the edge rather than discovered later.
 */
export const PROVIDER_IDS = [
	"openai",
	"anthropic",
	"gemini",
	"deepseek",
	"openrouter",
	"ollama",
	"custom",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Whether `value` is a known provider id. */
export function isProviderId(value: unknown): value is ProviderId {
	return (
		typeof value === "string" &&
		(PROVIDER_IDS as readonly string[]).includes(value)
	);
}

/**
 * Test state of a connection.
 *
 * `ok` is the only state in which a connection may become the active one. That
 * rule is enforced by `canActivate` rather than by disabling a button, so no
 * entry point can bypass it.
 */
export const CONNECTION_STATUSES = [
	"untested",
	"testing",
	"ok",
	"failed",
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** What a connection can accept as input. */
export interface ConnectionCapabilities {
	/** Can translate text. */
	readonly text: boolean;
	/** Can accept image input (vision / multimodal models). */
	readonly vision: boolean;
}

/** A saved connection. Never contains an API key. */
export interface Connection {
	readonly id: string;
	/** User-visible name. Defaults to `<Provider label> · <model>`. */
	readonly name: string;
	readonly provider: ProviderId;
	/** Base URL. Empty only while the user is still filling the form. */
	readonly endpoint: string;
	/** Model id. */
	readonly model: string;
	readonly capabilities: ConnectionCapabilities;
	readonly status: ConnectionStatus;
	/** Human-readable reason when `status` is `failed`. */
	readonly statusDetail?: string;
	/** Explicit tier assignment. Overrides derivation when present. */
	readonly tier?: ModelTier;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** The two tier semantics. See `tiers.ts` for how a tier resolves to a connection. */
export const MODEL_TIERS = ["advanced", "fast"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/** Fields a user can edit. Changing any of these invalidates a passed test. */
export const TEST_INVALIDATING_FIELDS = [
	"provider",
	"endpoint",
	"model",
] as const;

/** The editable subset of a connection. */
export type ConnectionEdit = Partial<
	Pick<
		Connection,
		"name" | "provider" | "endpoint" | "model" | "capabilities" | "tier"
	>
>;

/**
 * Why a connection cannot be activated.
 *
 * Returns `undefined` when activation is allowed. Reason strings are shown to
 * the user, so they name the concrete missing step rather than a generic
 * refusal.
 */
export function activationBlocker(
	connection: Pick<Connection, "endpoint" | "model" | "status">,
	hasKey: boolean,
): string | undefined {
	if (connection.endpoint.trim() === "") return "请填写 Endpoint";
	if (connection.model.trim() === "") return "请填写 Model";
	if (!hasKey) return "请填写 API Key";
	if (connection.status !== "ok") {
		return connection.status === "testing"
			? "连接测试进行中，请稍候"
			: "请先通过连接测试";
	}
	return undefined;
}

/** Whether a connection may become the active one. */
export function canActivate(
	connection: Pick<Connection, "endpoint" | "model" | "status">,
	hasKey: boolean,
): boolean {
	return activationBlocker(connection, hasKey) === undefined;
}

/**
 * Apply an edit to a connection, invalidating its test state when a tested
 * field changes.
 *
 * Without this, a connection could stay `ok` after its endpoint was repointed
 * elsewhere, and the passed test would silently describe a different endpoint.
 */
export function applyEdit(
	connection: Connection,
	edit: ConnectionEdit,
	now: number,
): Connection {
	const invalidates =
		(edit.provider !== undefined && edit.provider !== connection.provider) ||
		(edit.endpoint !== undefined && edit.endpoint !== connection.endpoint) ||
		(edit.model !== undefined && edit.model !== connection.model);

	return {
		...connection,
		...edit,
		status: invalidates ? "untested" : connection.status,
		statusDetail: invalidates ? undefined : connection.statusDetail,
		updatedAt: now,
	};
}

/**
 * Derive the default display name for a connection.
 *
 * Format: `<Provider label> · <model>`, falling back to the provider label
 * while the model is still empty.
 */
export function defaultConnectionName(
	providerLabel: string,
	model: string,
): string {
	const trimmed = model.trim();
	return trimmed === "" ? providerLabel : `${providerLabel} · ${trimmed}`;
}
