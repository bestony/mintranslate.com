import { createFileRoute, Link } from "@tanstack/react-router";

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
			{/* Same shell as the workspace so navigation is consistent and the
			    responsive breakpoints behave identically on both routes. */}
			<div className="border-line border-b bg-header-bg">
				<div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3 md:px-6">
					<Link to="/" className="display-title font-bold text-lg">
						MinTranslate
					</Link>
					<nav className="ml-auto flex items-center gap-4 text-sm">
						<Link to="/" className="nav-link">
							翻译
						</Link>
						<Link to="/history" className="nav-link">
							历史
						</Link>
						<Link to="/settings" className="nav-link">
							设置
						</Link>
					</nav>
				</div>
			</div>
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
		</>
	);
}
