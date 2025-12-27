import { randomBytes } from "node:crypto";
import type { Register } from "@tanstack/react-router";
import { renderRouterToStream } from "@tanstack/react-router/ssr/server";
import {
	createStartHandler,
	type RequestHandler,
	StartServer,
} from "@tanstack/react-start/server";
import { defineHandlerCallback } from "@tanstack/router-core/ssr/server";

function buildContentSecurityPolicy(nonce: string) {
	return [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		[
			"script-src",
			`'self'`,
			`'nonce-${nonce}'`,
			"https://www.googletagmanager.com",
			"https://pagead2.googlesyndication.com",
			"https://www.googletagservices.com",
			"https://tpc.googlesyndication.com",
			"https://securepubads.g.doubleclick.net",
		].join(" "),
		"style-src 'self' 'unsafe-inline'",
		[
			"img-src",
			"'self'",
			"data:",
			"https://pagead2.googlesyndication.com",
			"https://googleads.g.doubleclick.net",
			"https://tpc.googlesyndication.com",
			"https://www.google-analytics.com",
			"https://stats.g.doubleclick.net",
		].join(" "),
		[
			"connect-src",
			"'self'",
			"https://api.openai.com",
			"https://api.anthropic.com",
			"https://generativelanguage.googleapis.com",
			"https://www.google-analytics.com",
			"https://region1.google-analytics.com",
			"https://stats.g.doubleclick.net",
			"https://pagead2.googlesyndication.com",
			"https://googleads.g.doubleclick.net",
			"https://tpc.googlesyndication.com",
			"http://localhost:11434",
			"http://127.0.0.1:11434",
		].join(" "),
		"frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com",
	].join("; ");
}

const handler = defineHandlerCallback(
	({ request, router, responseHeaders }) => {
		const nonce = randomBytes(16).toString("base64");

		router.update({
			ssr: {
				...(router.options.ssr ?? {}),
				nonce,
			},
			context: {
				...(router.options.context ?? {}),
				cspNonce: nonce,
			},
		});

		responseHeaders.set(
			"Content-Security-Policy",
			buildContentSecurityPolicy(nonce),
		);

		return renderRouterToStream({
			request,
			router,
			responseHeaders,
			children: <StartServer router={router} />,
		});
	},
);

const fetch = createStartHandler(handler);

export type ServerEntry = { fetch: RequestHandler<Register> };

export function createServerEntry(entry: ServerEntry): ServerEntry {
	return {
		async fetch(...args) {
			return entry.fetch(...args);
		},
	};
}

export default createServerEntry({ fetch });
