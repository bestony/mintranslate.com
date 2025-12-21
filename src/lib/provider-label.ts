import type { AIProvider } from "@/stores/translateStore";

export function formatProviderLabel(
	provider: AIProvider | null,
	fallback: string,
) {
	if (!provider) return fallback;

	return `${provider.name} - ${provider.model}`;
}
