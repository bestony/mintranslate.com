/**
 * Install guidance and platform capabilities.
 *
 * The branch is on **capability**, not on browser name: whether the browser fires
 * an install-prompt event is a reliable signal, whereas a user-agent string is
 * neither stable nor a statement about what the browser can do. The platform name
 * is used only to pick which manual instructions to show.
 *
 * Presenting the truth matters more than presenting an install button here. A
 * platform that cannot install this application must say so, or the user reads a
 * missing feature as a broken one.
 */

/** How installation is available on the current platform. */
export const INSTALL_MODES = [
	/** The browser fires an install-prompt event; we can trigger it. */
	"prompt",
	/** No event, but the platform supports manual installation (iOS/iPadOS). */
	"manual",
	/** The platform cannot install a web app. */
	"unsupported",
] as const;

export type InstallMode = (typeof INSTALL_MODES)[number];

/** Platform family, used only to choose which instructions to show. */
export const PLATFORMS = [
	"ios",
	"android",
	"desktop-chromium",
	"desktop-safari",
	"firefox",
	"other",
] as const;

export type Platform = (typeof PLATFORMS)[number];

/** A capability and whether the current environment provides it. */
export interface Capability {
	readonly id: "install" | "offline" | "speech";
	readonly label: string;
	readonly available: boolean;
	/** Why it is unavailable, when it is. Phrased as a platform limit, not a bug. */
	readonly reason?: string;
}

export interface InstallEnvironment {
	/** Whether the browser fired an install-prompt event. */
	promptAvailable(): boolean;
	/** Whether the app is already running in a standalone window. */
	standalone(): boolean;
	platform(): Platform;
	/** Whether a service worker is active (offline capability depends on it). */
	offlineAvailable(): boolean;
	/** Whether the browser provides speech synthesis. */
	speechAvailable(): boolean;
}

/** What the interface should render. */
export interface InstallGuidance {
	readonly mode: InstallMode;
	/** True when the app is already installed; nothing should be shown. */
	readonly installed: boolean;
	/** Instructions for the manual path, when applicable. */
	readonly instructions?: string;
	/** Shown when installation is not possible at all. */
	readonly unsupportedNotice?: string;
}

/** Determine what to show for installation. */
export function resolveInstallGuidance(
	environment: InstallEnvironment,
): InstallGuidance {
	// An installed app is never offered installation again.
	if (environment.standalone()) {
		return {
			mode: "unsupported",
			installed: true,
			unsupportedNotice: undefined,
		};
	}

	if (environment.promptAvailable()) {
		return { mode: "prompt", installed: false };
	}

	const platform = environment.platform();

	// No prompt event, but the platform has a manual route.
	if (platform === "ios") {
		return {
			mode: "manual",
			installed: false,
			instructions: "在 Safari 中点击「分享」，然后选择「添加到主屏幕」。",
		};
	}

	if (platform === "firefox" || platform === "desktop-safari") {
		return {
			mode: "unsupported",
			installed: false,
			unsupportedNotice:
				"当前浏览器不支持安装为桌面应用。可改用 Chrome、Edge 或 Android/iOS 上的浏览器。",
		};
	}

	// Any other platform without the event: give the generic manual route rather
	// than nothing, since the browser menu usually offers it.
	return {
		mode: "manual",
		installed: false,
		instructions: "在浏览器菜单中选择「安装应用」或「添加到主屏幕」。",
	};
}

/**
 * Describe every capability the application exposes.
 *
 * This is what lets a user tell "my platform cannot do this" from "this is
 * broken" — the PRD asks for exactly that distinction.
 */
export function describeCapabilities(
	environment: InstallEnvironment,
): readonly Capability[] {
	const guidance = resolveInstallGuidance(environment);
	const insecure = !environment.offlineAvailable();

	return [
		{
			id: "install",
			label: "安装到桌面",
			available: !guidance.installed && guidance.mode !== "unsupported",
			...(guidance.mode === "unsupported" && !guidance.installed
				? { reason: "当前浏览器不支持安装" }
				: {}),
			...(insecure && guidance.mode !== "unsupported"
				? { reason: "需通过 HTTPS 访问才能安装" }
				: {}),
		},
		{
			id: "offline",
			label: "离线使用",
			// Offline needs a registered worker, which needs a secure context.
			available: environment.offlineAvailable(),
			...(insecure ? { reason: "需通过 HTTPS 访问才能启用离线能力" } : {}),
		},
		{
			id: "speech",
			label: "语音朗读",
			available: environment.speechAvailable(),
			...(environment.speechAvailable()
				? {}
				: { reason: "当前浏览器不支持语音合成" }),
		},
	];
}

/** Real environment, backed by the browser. */
export function createBrowserInstallEnvironment(
	hasPrompt: () => boolean,
): InstallEnvironment {
	return {
		promptAvailable: hasPrompt,
		standalone: () =>
			typeof globalThis.matchMedia === "function" &&
			globalThis.matchMedia("(display-mode: standalone)").matches,
		platform: () => detectPlatform(),
		// An active worker is what makes offline work. Without a secure context
		// there is no worker, so this is false there.
		offlineAvailable: () =>
			globalThis.isSecureContext === true &&
			typeof (globalThis as unknown as Navigator).serviceWorker?.controller !==
				"undefined",
		speechAvailable: () =>
			typeof (globalThis as unknown as { speechSynthesis?: unknown })
				.speechSynthesis !== "undefined",
	};
}

/**
 * Identify the platform family.
 *
 * Only used to choose which instructions to show, never to decide what the
 * browser can do.
 */
export function detectPlatform(
	userAgent: string = typeof navigator === "undefined"
		? ""
		: navigator.userAgent,
): Platform {
	const ua = userAgent.toLowerCase();

	// iPadOS reports a desktop UA, so a touch-capable "Macintosh" is an iPad.
	const isIpadOs =
		ua.includes("macintosh") &&
		typeof navigator !== "undefined" &&
		navigator.maxTouchPoints > 1;
	if (
		ua.includes("iphone") ||
		ua.includes("ipad") ||
		ua.includes("ipod") ||
		isIpadOs
	)
		return "ios";
	if (ua.includes("android")) return "android";
	if (ua.includes("firefox")) return "firefox";
	// Safari is the only major browser that reports neither `chrome` nor `chromium`.
	if (
		ua.includes("safari") &&
		!ua.includes("chrome") &&
		!ua.includes("chromium")
	) {
		return "desktop-safari";
	}
	if (ua.includes("chrome") || ua.includes("chromium") || ua.includes("edg")) {
		return "desktop-chromium";
	}
	return "other";
}
