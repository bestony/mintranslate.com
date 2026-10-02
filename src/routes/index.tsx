import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

/**
 * Placeholder home route.
 *
 * The translation workspace itself is built by the `core-translation` change.
 * This route only proves the shell boots with no application backend, so it
 * deliberately renders static content and loads no data.
 */
function Home() {
	return (
		<main className="page-wrap py-16">
			<p className="island-kicker">MinTranslate</p>
			<h1 className="display-title mt-3 font-bold text-4xl">
				自托管 AI 翻译工作台
			</h1>
			<p className="mt-4 max-w-xl text-lg text-muted-foreground">
				应用外壳已就绪。翻译工作区、模型接入与本地历史将在后续变更中交付。
			</p>
		</main>
	);
}
