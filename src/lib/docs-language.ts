import { normalizeAppLanguage } from "@/lib/app-i18n";

export type DocsLanguage = "en" | "zh";

export const DEFAULT_DOCS_LANGUAGE: DocsLanguage = "en";

export function detectDocsLanguage(
	value: string | null | undefined,
): DocsLanguage {
	return normalizeAppLanguage(value) ?? DEFAULT_DOCS_LANGUAGE;
}
