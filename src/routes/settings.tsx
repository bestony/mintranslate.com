import { createFileRoute } from "@tanstack/react-router";

import { SiteFooter, SiteHeader } from "#/components/SiteChrome";
import { SettingsPage } from "#/components/settings/SettingsPage";

export const Route = createFileRoute("/settings")({ component: SettingsRoute });

/**
 * Settings route.
 *
 * A standalone route rather than a panel (design.md Open Question 3), so it is
 * directly linkable and reachable without any model configuration — which is
 * what the "unconfigured start" requirement needs.
 *
 * The component is imported statically and the heavy work (provider adapters)
 * is loaded on demand inside it, so opening settings does not pull provider
 * code into the first screen.
 */
function SettingsRoute() {
	return (
		<>
			<SiteHeader />
			<main className="page-wrap py-10">
				<header className="mb-8">
					<h1 className="display-title mt-3 font-bold text-3xl">设置</h1>
					<p className="mt-2 max-w-2xl text-muted-foreground">
						配置你自己的模型连接。密钥只保存在本浏览器，不会发送到你所配置的
						Endpoint 以外的任何地址。
					</p>
				</header>
				<SettingsPage />
			</main>
			<SiteFooter />
		</>
	);
}
