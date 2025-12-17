import { useEffect } from "react";

import {
	hydrateProviderSettingsFromStorage,
	hydrateSystemPromptFromDb,
	hydrateTranslateLangPairFromStorage,
} from "@/stores/translateStore";

export function AppSettingsHydrator() {
	useEffect(() => {
		hydrateProviderSettingsFromStorage();
		hydrateTranslateLangPairFromStorage();
		void hydrateSystemPromptFromDb();
	}, []);

	return null;
}
