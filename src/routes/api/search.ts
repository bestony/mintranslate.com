import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";

const server = createFromSource(source, {
	// Orama doesn't have a dedicated Chinese tokenizer; fallback to English tokenization.
	localeMap: {
		zh: "english",
	},
});

export const Route = createFileRoute("/api/search")({
	server: {
		handlers: {
			GET: async ({ request }) => server.GET(request),
		},
	},
});
