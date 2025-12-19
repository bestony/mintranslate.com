declare module "fumadocs-mdx:collections/server" {
	import type { Source, SourceConfig } from "fumadocs-core/source";

	export const docs: {
		toFumadocsSource: () => Source<SourceConfig>;
	};
}

declare module "fumadocs-mdx:collections/browser" {
	const collections: any;
	export default collections;
}
