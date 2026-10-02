/**
 * Model tier resolution.
 *
 * Two tiers: `advanced` favours quality, `fast` favours latency and cost. A
 * tier resolves to a saved connection. The resolution is derived rather than
 * stored per request, so it follows the user's configuration.
 *
 * Open question 1 from design.md, resolved as: an explicit per-connection tier
 * assignment wins; otherwise vision-capable connections are treated as the
 * stronger ones. When nothing can serve a tier, the caller must surface that
 * instead of silently substituting another connection — see `TierResolution`.
 */

import type { Connection, ModelTier } from "./model";

/** Outcome of resolving one tier. */
export type TierResolution =
	| {
			readonly kind: "resolved";
			readonly connection: Connection;
			readonly derived: boolean;
	  }
	| { readonly kind: "unavailable"; readonly reason: string };

/**
 * Rank a connection for a tier.
 *
 * Higher is better for `advanced`. Explicit assignment dominates; a vision
 * connection is treated as stronger than a text-only one because the
 * multimodal models in scope are the higher-capability ones.
 */
function strengthScore(connection: Connection): number {
	let score = 0;
	if (connection.tier === "advanced") score += 100;
	if (connection.tier === "fast") score -= 100;
	if (connection.capabilities.vision) score += 10;
	if (connection.capabilities.text) score += 1;
	return score;
}

/** Only connections that have passed their test may be used. */
function usable(connections: readonly Connection[]): Connection[] {
	return connections.filter(
		(connection) =>
			connection.status === "ok" &&
			connection.endpoint.trim() !== "" &&
			connection.model.trim() !== "",
	);
}

/**
 * Resolve which connection serves `tier`.
 *
 * Never falls back to the other tier: if the requested tier has no usable
 * connection, that is reported so the user can be told, rather than being
 * quietly served by a connection they did not choose.
 */
export function resolveTier(
	tier: ModelTier,
	connections: readonly Connection[],
): TierResolution {
	const candidates = usable(connections);
	if (candidates.length === 0) {
		return {
			kind: "unavailable",
			reason: "尚未配置任何可用连接（需先通过连接测试）",
		};
	}

	const explicitlyAssigned = candidates.filter(
		(connection) => connection.tier === tier,
	);
	if (explicitlyAssigned.length > 0) {
		// Most recently updated wins, so editing a connection makes it current.
		const chosen = explicitlyAssigned.reduce((best, candidate) =>
			candidate.updatedAt > best.updatedAt ? candidate : best,
		);
		return { kind: "resolved", connection: chosen, derived: false };
	}

	// No explicit assignment: derive. Exclude connections the user assigned to
	// the *other* tier, so an explicit assignment is never overridden.
	const unassigned = candidates.filter(
		(connection) => connection.tier === undefined,
	);
	if (unassigned.length === 0) {
		return {
			kind: "unavailable",
			reason:
				tier === "advanced"
					? "没有可用于「高级」档的连接，请在连接设置中指定"
					: "没有可用于「快速」档的连接，请在连接设置中指定",
		};
	}

	const ranked = [...unassigned].sort((a, b) => {
		const difference = strengthScore(b) - strengthScore(a);
		if (difference !== 0) return difference;
		// Tie-break on recency so the newest configuration wins.
		return b.updatedAt - a.updatedAt;
	});

	const chosen = tier === "advanced" ? ranked[0] : ranked[ranked.length - 1];
	return { kind: "resolved", connection: chosen, derived: true };
}

/**
 * Human-readable description of what a tier is currently using.
 *
 * Requirement: the tier must never be a black box, so this names the concrete
 * connection and model.
 */
export function describeTierTarget(
	tier: ModelTier,
	connections: readonly Connection[],
): string {
	const resolution = resolveTier(tier, connections);
	if (resolution.kind === "unavailable") return resolution.reason;
	return `${resolution.connection.name}（${resolution.connection.model}）`;
}
