import { createFileRoute, Link } from "@tanstack/react-router";

import { UnconfiguredNotice } from "#/components/settings/UnconfiguredNotice";

export const Route = createFileRoute("/")({ component: Home });

/**
 * Placeholder home route.
 *
 * The translation workspace itself is built by the `core-translation` change.
 * This route proves two things this change is responsible for: the shell boots
 * with no application backend, and an unconfigured install still renders and
 * points at settings instead of failing.
 *
 * It deliberately loads no data, so prerendering the shell cannot fail.
 */
function Home() {
	return (
		<main className="page-wrap py-16">
			<p className="island-kicker">MinTranslate</p>
			<h1 className="display-title mt-3 font-bold text-4xl">
				自托管 AI 翻译工作台
			</h1>
			<p className="mt-4 max-w-xl text-lg text-muted-foreground">
				翻译工作区与本地历史将在后续变更中交付。现在可以先配置你自己的模型连接。
			</p>

			<UnconfiguredNotice />

			<div className="mt-8">
				<Link to="/settings" className="nav-link font-medium">
					前往设置 →
				</Link>
			</div>
		</main>
	);
}
