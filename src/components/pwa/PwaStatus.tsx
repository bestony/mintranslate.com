/**
 * PWA status surface: update prompt, install entry, offline notice.
 *
 * Rendered from the shell so it appears on every route. Three rules it follows:
 *
 * - Nothing here blocks the interface. The update prompt is dismissible, the
 *   install entry is small, and neither covers the translation input.
 * - Nothing here is silent. When a capability is missing the reason is stated, so
 *   a platform limit is not read as a defect.
 * - Install guidance is capability-driven: a prompt button where the browser
 *   supports one, instructions where it does not, and an honest "not supported"
 *   where there is no route at all.
 */

import { useState } from "react";

import { usePwa } from "./usePwa";

export function PwaStatus() {
	const pwa = usePwa();
	const [dismissedUpdate, setDismissedUpdate] = useState(false);

	const showUpdate = pwa.updateReady && !dismissedUpdate;

	return (
		<>
			{/* Offline notice: persistent while offline, since translation stays
			    unavailable for as long as the state lasts. */}
			{!pwa.online && (
				<output className="block border-b border-border bg-surface px-4 py-2 text-muted-foreground text-sm">
					当前处于离线状态：可以浏览历史与修改设置，翻译需要网络或内网模型。
				</output>
			)}

			{showUpdate && (
				<div className="flex flex-wrap items-center gap-4 border-b border-border bg-surface px-4 py-2 text-sm">
					<span>有新版本可用。</span>
					<button
						type="button"
						className="nav-link min-h-11 inline-flex items-center"
						onClick={pwa.applyUpdate}
					>
						更新
					</button>
					<button
						type="button"
						className="nav-link min-h-11 inline-flex items-center text-muted-foreground"
						onClick={() => setDismissedUpdate(true)}
					>
						稍后
					</button>
				</div>
			)}

			{pwa.upToDateNotice !== undefined && (
				<output className="block border-b border-border px-4 py-2 text-muted-foreground text-xs">
					{pwa.upToDateNotice}
				</output>
			)}
		</>
	);
}

/**
 * Compact install entry for the toolbar.
 *
 * Rendered only when the browser can actually prompt, which is what keeps it from
 * being a button that does nothing. The fuller guidance (including the manual
 * paths) lives in settings.
 */
export function InstallButton() {
	const pwa = usePwa();
	if (!pwa.canPromptInstall) return null;

	return (
		<button
			type="button"
			className="nav-link min-h-11 inline-flex items-center text-xs"
			onClick={pwa.requestInstall}
		>
			安装到桌面
		</button>
	);
}
