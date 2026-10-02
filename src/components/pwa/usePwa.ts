/**
 * React binding for the PWA capabilities.
 *
 * Wires the tested modules (`registration`, `update`, `install`, `offline`) to
 * component state. The browser-facing decisions stay in those modules so they can
 * be tested without a DOM; this hook only subscribes and re-renders.
 *
 * Everything here degrades to "not available" rather than throwing: an insecure
 * origin, a browser without workers, or a blocked registration all leave the
 * application fully usable — and the interface reports why the capability is
 * missing instead of showing a control that does nothing.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { logger } from "#/lib/logger";
import {
	type Capability,
	createBrowserInstallEnvironment,
	describeCapabilities,
	type InstallGuidance,
	type Platform,
	resolveInstallGuidance,
} from "#/lib/pwa/install";
import {
	canPromptInstall as canPrompt,
	observeInstallPrompt,
	promptInstall,
	subscribeInstallPrompt,
} from "#/lib/pwa/install-prompt";
import {
	createConnectivityState,
	type FeatureKind,
	isFeatureAvailable,
	unavailableReason as unavailableReasonFor,
} from "#/lib/pwa/offline";
import { createServiceWorkerRegistration } from "#/lib/pwa/registration";
import {
	createBrowserUpdateEnvironment,
	createUpdateFlow,
} from "#/lib/pwa/update";

/** What the interface consumes. */
export interface PwaState {
	/** Whether a new version is downloaded and waiting for confirmation. */
	readonly updateReady: boolean;
	/** Set after a manual check that found nothing. */
	readonly upToDateNotice: string | undefined;
	/** Whether the browser can prompt for installation right now. */
	readonly canPromptInstall: boolean;
	/** What to show for installation on this platform. */
	readonly installGuidance: InstallGuidance;
	/** Current platform family, for the instructions. */
	readonly platform: Platform;
	/** Whether the device is online, as far as the browser knows. */
	readonly online: boolean;
	/** Platform capability matrix. */
	readonly capabilities: readonly Capability[];
	/** Whether a feature may be used right now. */
	featureAvailable: (kind: FeatureKind) => boolean;
	/** Explanation when a feature is unavailable. */
	unavailableReason: (kind: FeatureKind) => string | undefined;
	applyUpdate: () => void;
	checkForUpdate: () => void;
	requestInstall: () => void;
}

export function usePwa(): PwaState {
	const [updateReady, setUpdateReady] = useState(false);
	const [upToDateNotice, setUpToDateNotice] = useState<string | undefined>(
		undefined,
	);
	const [canPromptInstall, setCanPromptInstall] = useState(false);
	const [online, setOnline] = useState(true);
	const [platform, setPlatform] = useState<Platform>("other");
	const [offlineAvailable, setOfflineAvailable] = useState(false);

	const registration = useMemo(() => createServiceWorkerRegistration(), []);
	const updateFlow = useMemo(
		() =>
			createUpdateFlow(
				createBrowserUpdateEnvironment(() => registration.current()),
			),
		[registration],
	);
	const connectivity = useMemo(() => createConnectivityState(), []);

	// Register the worker once, then let the update flow drive it.
	useEffect(() => {
		let cancelled = false;

		void registration.register().then((outcome) => {
			if (cancelled) return;
			// A waiting worker at registration time is already an update.
			if (
				outcome.kind === "registered" &&
				outcome.registration.waiting !== null
			) {
				updateFlow.markWaiting();
			}
			setOfflineAvailable(outcome.kind === "registered");
		});

		const stopUpdates = updateFlow.subscribe((state) => {
			setUpdateReady(state.updateReady);
			setUpToDateNotice(state.upToDateNotice);
		});

		return () => {
			cancelled = true;
			stopUpdates();
			registration.dispose();
			updateFlow.dispose();
		};
	}, [registration, updateFlow]);

	// Connectivity.
	useEffect(() => {
		setOnline(connectivity.online());
		return connectivity.subscribe(setOnline);
	}, [connectivity]);

	// Install prompt: the event is a single-owner resource, so this subscribes to
	// the shared capture rather than installing its own listener.
	useEffect(() => {
		observeInstallPrompt();
		setCanPromptInstall(canPrompt());
		return subscribeInstallPrompt(() => setCanPromptInstall(canPrompt()));
	}, []);

	const environment = useMemo(
		() => createBrowserInstallEnvironment(() => canPromptInstall),
		[canPromptInstall],
	);

	// Platform is read once; it cannot change within a session.
	useEffect(() => {
		setPlatform(environment.platform());
	}, [environment]);

	const applyUpdate = useCallback(() => {
		updateFlow.apply();
	}, [updateFlow]);

	const checkForUpdate = useCallback(() => {
		void updateFlow.checkNow();
		logger.debug("pwa.update.manual-check");
	}, [updateFlow]);

	const requestInstall = useCallback(() => {
		void promptInstall().then((outcome) => {
			if (outcome === undefined) return;
			logger.info("pwa.install.choice", { outcome });
		});
	}, []);

	const installGuidance = useMemo(
		() =>
			resolveInstallGuidance({
				...environment,
				platform: () => platform,
				// Offline depends on an active worker, which only exists after a
				// successful registration in a secure context.
				offlineAvailable: () => offlineAvailable,
			}),
		[environment, platform, offlineAvailable],
	);

	const capabilities = useMemo(
		() =>
			describeCapabilities({
				...environment,
				platform: () => platform,
				offlineAvailable: () => offlineAvailable,
			}),
		[environment, platform, offlineAvailable],
	);

	return {
		updateReady,
		upToDateNotice,
		canPromptInstall,
		installGuidance,
		platform,
		online,
		capabilities,
		featureAvailable: (kind) => isFeatureAvailable(kind, online),
		unavailableReason: (kind) => unavailableReasonFor(kind, online),
		applyUpdate,
		checkForUpdate,
		requestInstall,
	};
}
