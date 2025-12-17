import { useEffect } from "react";

import { detectAppLanguage, setAppLanguage } from "@/lib/app-i18n";

export function AppI18nHydrator({ routeLang }: { routeLang?: string }) {
	useEffect(() => {
		const lang = detectAppLanguage(routeLang);
		void setAppLanguage(lang);
	}, [routeLang]);

	return null;
}
