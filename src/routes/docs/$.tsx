import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/docs/$")({
	loader: ({ params }) => {
		throw redirect({
			to: "/$lang/docs/$",
			params: {
				lang: "en",
				_splat: params._splat ?? "",
			},
			replace: true,
		});
	},
	component: () => null,
});
