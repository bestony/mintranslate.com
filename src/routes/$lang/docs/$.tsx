import browserCollections from "fumadocs-mdx:collections/browser";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import type { TOCItemType } from "fumadocs-core/toc";
import type { CompiledMDXProperties } from "fumadocs-mdx";
import { defineI18nUI } from "fumadocs-ui/i18n";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { i18n } from "@/lib/i18n";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

import docsCss from "../../../docs.css?url";

const { provider } = defineI18nUI(i18n, {
	translations: {
		en: {
			displayName: "English",
			search: "Search",
		},
		zh: {
			displayName: "中文",
			search: "搜索",
		},
	},
});

export const Route = createFileRoute("/$lang/docs/$")({
	component: Page,
	codeSplitGroupings: [["loader", "component"]],
	head: () => ({
		links: [
			{
				rel: "stylesheet",
				href: docsCss,
			},
		],
	}),
	loader: async ({ params }) => {
		const slugs = params._splat?.split("/") ?? [];
		const data = await serverLoader({
			data: {
				slugs,
				lang: params.lang,
			},
		});
		await clientLoader.preload(data.path);
		return data;
	},
});

const serverLoader = createServerFn({
	method: "GET",
})
	.inputValidator((params: { slugs: string[]; lang: string }) => params)
	.handler(async ({ data: { slugs, lang } }) => {
		const page = source.getPage(slugs, lang);
		if (!page) throw notFound();

		return {
			path: page.path,
			pageTree: await source.serializePageTree(source.getPageTree(lang)),
		};
	});

const clientLoader = browserCollections.docs.createClientLoader({
	component({
		toc,
		frontmatter,
		default: MDX,
	}: {
		toc: TOCItemType[];
		frontmatter: { title?: string; description?: string };
		default: CompiledMDXProperties["default"];
	}) {
		return (
			<DocsPage toc={toc}>
				<DocsTitle>{frontmatter.title}</DocsTitle>
				<DocsDescription>{frontmatter.description}</DocsDescription>
				<DocsBody>
					<MDX
						components={{
							...defaultMdxComponents,
						}}
					/>
				</DocsBody>
			</DocsPage>
		);
	},
});

function Page() {
	const { lang } = Route.useParams();
	const data = Route.useLoaderData();
	const { pageTree } = useFumadocsLoader(data);
	const Content = clientLoader.getComponent(data.path);
	const locale = lang === "en" || lang === "zh" ? lang : i18n.defaultLanguage;

	return (
		<RootProvider i18n={provider(locale)}>
			<DocsLayout {...baseOptions(locale)} tree={pageTree}>
				<Content />
			</DocsLayout>
		</RootProvider>
	);
}
