/**
 * Settings-page analytics binding.
 *
 * This hook no longer initialises analytics or reports page views: both belong to
 * the shell (`./root`), because they must happen on every route. What remains here
 * is exactly what the settings page needs — the statistics toggle, and whether the
 * identifier is deployment-controlled.
 *
 * Initialisation living here was the defect: mounting this hook only on the
 * settings route silently stopped analytics everywhere else, because nothing else
 * ever injected the script.
 */

import { useCallback, useEffect, useState } from "react";
import { MEASUREMENT_ID_KEY } from "#/lib/analytics/config";
import {
	analytics,
	notifyStatisticsChanged,
	subscribeStatistics,
} from "#/lib/analytics/instance";
import { createAnalyticsLoader } from "#/lib/analytics/loader";
import { logger } from "#/lib/logger";

/** The hook surface. */
export interface AnalyticsBinding {
	readonly analytics: ReturnType<typeof analytics>;
	readonly statisticsOn: boolean;
	setStatisticsOn: (value: boolean) => void;
	/** Whether the settings field must be read-only because a deployment set it. */
	readonly idFromDeployment: boolean;
	/** The identifier a user may edit; `''` when a deployment supplies it. */
	readonly editableId: string;
}

/** Read a storage slot without throwing. */
function localStorageSafe(key: string): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

/**
 * Bind the settings page to the shared analytics instance.
 *
 * The loader is created here only to drive the toggle; it does not initialise,
 * because the shell already did.
 */
export function useAnalytics(): AnalyticsBinding {
	const [statisticsOn, setStatisticsOn] = useState(true);
	const [idFromDeployment, setIdFromDeployment] = useState(false);
	const [editableId, setEditableId] = useState("");

	useEffect(() => {
		setStatisticsOn(createAnalyticsLoader().statisticsEnabled());

		// Report whether the field is deployment-controlled, so the settings input
		// can be read-only rather than looking editable.
		try {
			const fromEnv = Boolean(import.meta.env?.VITE_GA_MEASUREMENT_ID);
			const enabledByBuild =
				import.meta.env?.VITE_GA_ENABLED?.trim().toLowerCase() !== "false";
			setIdFromDeployment(fromEnv && enabledByBuild);
		} catch {
			setIdFromDeployment(false);
		}

		setEditableId(localStorageSafe(MEASUREMENT_ID_KEY) ?? "");
	}, []);

	// Keep the field in step when the toggle changes elsewhere.
	useEffect(
		() =>
			subscribeStatistics(() => {
				setStatisticsOn(createAnalyticsLoader().statisticsEnabled());
			}),
		[],
	);

	const setStatistics = useCallback((value: boolean) => {
		setStatisticsOn(value);
		const loader = createAnalyticsLoader();
		if (value) loader.enable();
		else loader.disable();
		notifyStatisticsChanged();
		logger.debug("analytics.toggle", { enabled: value });
	}, []);

	return {
		analytics: analytics(),
		statisticsOn,
		setStatisticsOn: setStatistics,
		idFromDeployment,
		editableId,
	};
}
