/**
 * Pre-call capability guard.
 *
 * The requirement is that a text-only connection must be refused *before* a
 * request is sent, not after it fails. Checking here — as a pure function over
 * the connection and the task — means every call site gets the same answer and
 * the check cannot drift between entry points.
 */

import type { Connection } from "./model";

/** What a call needs from a connection. */
export type CallRequirement = "text" | "vision";

/** Refusal reason, or `undefined` when the connection can serve the call. */
export function capabilityBlocker(
	connection: Pick<Connection, "capabilities" | "name">,
	requirement: CallRequirement,
): string | undefined {
	if (requirement === "vision" && !connection.capabilities.vision) {
		return `当前连接「${connection.name}」不支持图片输入。请切换到具备视觉能力的多模态模型。`;
	}

	if (requirement === "text" && !connection.capabilities.text) {
		return `当前连接「${connection.name}」未标记为可处理文本。请检查连接的能力设置。`;
	}

	return undefined;
}

/** Whether a connection can serve a call of this kind. */
export function canServe(
	connection: Pick<Connection, "capabilities" | "name">,
	requirement: CallRequirement,
): boolean {
	return capabilityBlocker(connection, requirement) === undefined;
}
