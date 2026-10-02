/**
 * Share menu.
 *
 * Presents the channels decided by `planShareChannels`: the system share sheet
 * when the environment offers it, with copy/mail/social always available as a
 * fallback. A system sheet that throws or is cancelled falls back rather than
 * reporting a failure — dismissing a sheet is normal, not an error.
 */

import { useEffect, useState } from "react";
import { logger } from "#/lib/logger";
import {
	buildMailtoLink,
	buildShareLink,
	buildSocialLink,
	isShareCancellation,
	planShareChannels,
} from "#/lib/share";
import { copyPlainText } from "#/lib/translation/result";

interface ShareMenuProps {
	readonly sourceLang: string;
	readonly targetLang: string;
	readonly sourceText: string;
	readonly targetText: string;
	/** Injected for tests; the browser value is derived when omitted. */
	readonly systemShare?: (data: {
		title: string;
		text: string;
		url?: string;
	}) => Promise<void>;
	readonly openInNewTab?: (url: string) => void;
}

export function ShareMenu({
	sourceLang,
	targetLang,
	sourceText,
	targetText,
	systemShare,
	openInNewTab,
}: ShareMenuProps) {
	const [open, setOpen] = useState(false);
	const [message, setMessage] = useState<string | undefined>(undefined);

	// `navigator.share` is the environment's own capability; when the caller did
	// not inject one, ask the browser and treat absence as "not available".
	/**
	 * The system share sheet is resolved after mount, not during render.
	 *
	 * `navigator.share` presence changes which channels are offered, so reading it
	 * during render would make the first client render structurally different from
	 * the prerendered HTML. Resolving it in an effect keeps the first frame
	 * identical and adds the channel a moment later.
	 */
	const [shareFn, setShareFn] =
		useState<ShareMenuProps["systemShare"]>(systemShare);

	useEffect(() => {
		if (systemShare !== undefined) return;
		if (typeof navigator === "undefined") return;
		if (typeof navigator.share !== "function") return;
		const share = navigator.share.bind(navigator);
		setShareFn(
			() => (data: { title: string; text: string; url?: string }) =>
				share(data),
		);
	}, [systemShare]);

	const plan = planShareChannels(shareFn !== undefined);

	const link = buildShareLink({
		sourceLang,
		targetLang,
		text: sourceText,
		mode: "translate",
	});

	function openTab(url: string) {
		if (openInNewTab) {
			openInNewTab(url);
			return;
		}
		window.open(url, "_blank", "noopener,noreferrer");
	}

	/** System sheet first; on failure (other than a cancel) fall back to the menu. */
	async function shareViaSystem() {
		if (!shareFn) return false;

		try {
			await shareFn({ title: "MinTranslate", text: targetText, url: link.url });
			logger.info("share.system.done");
			return true;
		} catch (error) {
			if (isShareCancellation(error)) {
				// The user dismissed the sheet: not a failure, nothing to report.
				return true;
			}

			logger.warn("share.system.failed", { error });
			setMessage("系统分享不可用，请使用下面的方式。");
			return false;
		}
	}

	async function handlePrimary() {
		if (plan.preferSystemShare) {
			const handled = await shareViaSystem();
			if (handled) return;
		}
		// Either no system sheet, or it failed: show the built-in options.
		setOpen(true);
	}

	async function copyLink() {
		const outcome = await copyPlainText(link.url);
		setMessage(
			outcome.kind === "copied" ? "分享链接已复制。" : outcome.message,
		);
	}

	function mail() {
		openTab(buildMailtoLink(targetText));
	}

	function social() {
		openTab(buildSocialLink(targetText));
	}

	return (
		<div className="flex flex-wrap items-center gap-3">
			<button
				type="button"
				className="nav-link text-xs"
				onClick={() => void handlePrimary()}
			>
				分享
			</button>

			{open && (
				<div className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface/60 px-2 py-1">
					<button
						type="button"
						className="nav-link text-xs"
						onClick={() => void copyLink()}
					>
						复制链接
					</button>
					<button type="button" className="nav-link text-xs" onClick={mail}>
						邮件
					</button>
					<button type="button" className="nav-link text-xs" onClick={social}>
						社交平台
					</button>
					<button
						type="button"
						className="nav-link text-xs"
						onClick={() => setOpen(false)}
					>
						关闭
					</button>
				</div>
			)}

			{/* Sharing a partial link must be stated, not discovered by the receiver. */}
			{!link.includesText && (
				<span className="text-xs text-amber-600">{link.notice}</span>
			)}

			{message !== undefined && (
				<span className="text-muted-foreground text-xs">{message}</span>
			)}
		</div>
	);
}
