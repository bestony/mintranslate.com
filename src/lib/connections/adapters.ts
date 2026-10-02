/**
 * Adapter factory: connection configuration to a `@tanstack/ai` text adapter.
 *
 * Every provider difference is resolved here and nowhere else (design.md D1).
 * Upstream code asks for an adapter and never branches on the provider.
 *
 * ## Why dynamic imports
 *
 * Bundling all four provider adapters statically put 1.65 MB into the first
 * screen and pulled in endpoint constants (`api.openai.com`,
 * `auth.openai.com`, `generativelanguage.googleapis.com`) that the application
 * only needs once the user actually translates. Each provider is therefore
 * loaded through a literal-path `await import()` so the code is fetched on
 * demand (design.md D2).
 *
 * The paths must stay literals: a computed specifier cannot be analysed by the
 * bundler and would either fail the build or pull everything back in.
 *
 * Types come in through `import type`, which is erased at compile time and
 * therefore does not re-introduce a runtime dependency.
 */

import type { AnyTextAdapter } from "@tanstack/ai";

import type { Connection } from "./model";

/** Re-export the base type so callers need not import from the package directly. */
export type { AnyTextAdapter };

/**
 * Input to adapter construction.
 *
 * `apiKey` is passed in per call rather than stored on the object, so an
 * adapter never becomes a place a key can be read out of later.
 */
export interface AdapterRequest {
	readonly provider: Connection["provider"];
	readonly endpoint: string;
	readonly model: string;
	readonly apiKey: string;
}

/**
 * The SDKs type their model parameter as a union of known model ids, which is
 * helpful for their built-in catalogue but wrong for this application: a
 * connection's model id is free text the user typed, and it may name a model
 * the SDK has never heard of (a self-hosted model, a newly released one, or an
 * OpenRouter slug). The value is forwarded verbatim to the endpoint.
 *
 * The cast is confined to this one helper so the reason is documented once and
 * the unsoundness does not spread.
 */
function asProviderModel<TModel extends string>(model: string): TModel {
	return model as TModel;
}

/**
 * OpenAI-compatible client options.
 *
 * `dangerouslyAllowBrowser` is the vendor's own opt-in for browser use: the
 * `openai` SDK refuses to construct in a browser without it. Passing it is
 * required for a pure-frontend deployment, not a workaround (see the
 * `browser-direct-connect` spec capability).
 */
export function openAiCompatibleOptions(
	request: Pick<AdapterRequest, "endpoint" | "apiKey">,
) {
	return {
		apiKey: request.apiKey,
		baseURL: request.endpoint,
		dangerouslyAllowBrowser: true as const,
	};
}

/**
 * Build an adapter for a connection, loading only that provider's package.
 */
export async function createAdapter(
	request: AdapterRequest,
): Promise<AnyTextAdapter> {
	switch (request.provider) {
		case "anthropic": {
			const { createAnthropicChat } = await import("@tanstack/ai-anthropic");
			// `dangerouslyAllowBrowser` is Anthropic's official browser opt-in. The
			// SDK derives the required `anthropic-dangerous-direct-browser-access`
			// request header from it, so this single option satisfies both of the
			// vendor's stated conditions. It is a documented mechanism, not a bypass.
			return createAnthropicChat(
				asProviderModel(request.model),
				request.apiKey,
				{
					baseURL: request.endpoint,
					dangerouslyAllowBrowser: true,
				},
			);
		}

		case "ollama": {
			// The bare `ollama` specifier is aliased to `ollama/browser` in
			// vite.config.ts, because the package's default entry imports `node:fs`
			// and `node:path`. That alias resolves the client for browser use, so this
			// branch only has to supply the host.
			const { createOllamaChat } = await import("@tanstack/ai-ollama");
			return createOllamaChat(asProviderModel(request.model), {
				host: request.endpoint,
			});
		}

		case "gemini": {
			const { createGeminiChat } = await import("@tanstack/ai-gemini");
			return createGeminiChat(asProviderModel(request.model), request.apiKey, {
				baseURL: request.endpoint,
			});
		}

		// `openai`, `deepseek`, `openrouter` and `custom` all use the compatible
		// adapter, so they are handled by `default` rather than by redundant labels.
		default: {
			// Every OpenAI-protocol endpoint goes through the compatible adapter, so
			// a self-hosted gateway and a built-in preset share one code path.
			const { openaiCompatibleText } = await import(
				"@tanstack/ai-openai/compatible"
			);
			return openaiCompatibleText(
				request.model,
				openAiCompatibleOptions(request),
			);
		}
	}
}

/**
 * Build an adapter from a saved connection plus its key.
 *
 * Separate from `createAdapter` so callers pass a connection without reaching
 * into key storage themselves.
 */
export async function createAdapterForConnection(
	connection: Connection,
	apiKey: string,
): Promise<AnyTextAdapter> {
	return createAdapter({
		provider: connection.provider,
		endpoint: connection.endpoint,
		model: connection.model,
		apiKey,
	});
}

/**
 * Provider-specific request options for a minimal probe call.
 *
 * Every provider spells "cap the output length" differently, so the mapping
 * lives beside the rest of the provider knowledge. The cap keeps a connection
 * test as close to free as possible while still exercising auth, routing and
 * response parsing.
 *
 * The cast is confined here for the same reason as `asProviderModel`: the
 * option bag is typed per provider, and this helper is the only place that
 * needs to cross that boundary.
 */
export function probeModelOptions(
	provider: Connection["provider"],
	maxOutputTokens: number,
): Record<string, unknown> {
	switch (provider) {
		case "anthropic":
			return { max_tokens: maxOutputTokens };
		case "gemini":
			return { maxOutputTokens };
		case "ollama":
			return { num_predict: maxOutputTokens };
		case "openai":
		case "deepseek":
		case "openrouter":
		// `custom` falls through to `default`: it is an OpenAI-protocol endpoint.
		default:
			return { max_output_tokens: maxOutputTokens };
	}
}
