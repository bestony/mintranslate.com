declare module "fumadocs-mdx:collections/server" {
	import type { Source, SourceConfig } from "fumadocs-core/source";

	export const docs: {
		toFumadocsSource: () => Source<SourceConfig>;
	};
}

declare module "fumadocs-mdx:collections/browser" {
	import type { DocCollectionEntry } from "fumadocs-mdx/runtime/browser";

	type DocsFrontmatter = {
		title?: string;
		description?: string;
	};

	const collections: {
		docs: DocCollectionEntry<string, DocsFrontmatter>;
	};
	export default collections;
}
