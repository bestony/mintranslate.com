/**
 * Notice shown on the home route when no connection is usable yet.
 *
 * The requirement this satisfies is about what must NOT happen: an
 * unconfigured install must not crash, blank the screen, or block the rest of
 * the application. So this component renders nothing until storage has actually
 * been read, and when it does render it only adds guidance — the surrounding
 * page works either way.
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { loadConnections, loadKeys } from "#/lib/connections/storage";

/**
 * Whether an unconfigured install has been ruled out.
 *
 * `undefined` means "not known yet": the shell is prerendered without storage,
 * so the real state is only knowable after hydration. Staying `undefined` until
 * then keeps the prerendered output and the first client render identical.
 */
type ConfiguredState = boolean | undefined;

/** Read whether at least one connection is tested and keyed. */
function hasUsableConnection(): boolean {
	if (typeof window === "undefined") return false;
	try {
		const store = window.localStorage;
		const { value: connections } = loadConnections(store);
		const keys = loadKeys(store);

		return connections.some(
			(connection) =>
				connection.status === "ok" &&
				connection.endpoint.trim() !== "" &&
				connection.model.trim() !== "" &&
				(keys[connection.id] ?? "").trim() !== "",
		);
	} catch {
		// Storage can be unavailable. Treat that as "not configured" so the user
		// gets guidance rather than a silent dead end.
		return false;
	}
}

export function UnconfiguredNotice() {
	const [configured, setConfigured] = useState<ConfiguredState>(undefined);

	useEffect(() => {
		setConfigured(hasUsableConnection());
	}, []);

	// Unknown yet, or already configured: nothing to say.
	if (configured !== false) return null;

	return (
		<div className="island-shell mt-8 rounded-md p-6">
			<p className="font-medium">还没有可用的模型连接</p>
			<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
				翻译需要一个你自己的模型 Endpoint 与 API
				Key。密钥只保存在本浏览器，不会经过任何中间服务。
				应用的其他部分不受影响，随时可以回来配置。
			</p>
			<Link to="/settings" className="mt-4 inline-block nav-link text-sm">
				去设置连接 →
			</Link>
		</div>
	);
}
