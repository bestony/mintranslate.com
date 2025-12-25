import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { Lang } from "@/stores/translateStore";

export function useLangLabels(): Record<Lang, string> {
	const { t } = useTranslation();

	return useMemo(
		() => ({
			zh: t("common.languages.zh"),
			en: t("common.languages.en"),
			fr: t("common.languages.fr"),
			ja: t("common.languages.ja"),
			es: t("common.languages.es"),
		}),
		[t],
	);
}
