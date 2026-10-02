/**
 * Site chrome: the header shown on every route and the footer that carries the
 * keyboard reference.
 *
 * Shared rather than repeated per route: the three routes previously each declared
 * their own markup for the same bar, which is how they drifted (one used `header`
 * and another a `div`). One component keeps the landmark, the spacing and the
 * install entry identical everywhere.
 */

import { Link } from "@tanstack/react-router";

import { usePwa } from "./pwa/usePwa";

/** Routes in the order they are shown. */
const NAV = [
	{ to: "/", label: "翻译" },
	{ to: "/history", label: "历史" },
	{ to: "/settings", label: "设置" },
] as const;

/**
 * The header: brand, navigation, and — when the browser can actually install — a
 * compact install control.
 *
 * The install control is hidden unless a prompt is available, so it is never a
 * button that does nothing. The full guidance stays in settings.
 */
export function SiteHeader() {
	const pwa = usePwa();

	return (
		<header className="border-b border-border bg-background">
			<div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3 md:px-6">
				<Link
					to="/"
					className="display-title flex min-h-11 items-center font-bold text-lg"
				>
					MinTranslate
				</Link>

				{pwa.canPromptInstall && (
					<button
						type="button"
						// Icon-sized visually, 44px for the touch target.
						className="ml-auto flex min-h-11 min-w-11 items-center justify-center rounded-sm border border-border text-sm"
						title="安装到桌面"
						aria-label="安装到桌面"
						onClick={pwa.requestInstall}
					>
						↓
					</button>
				)}

				<nav
					className={`flex items-center gap-4 text-sm ${pwa.canPromptInstall ? "" : "ml-auto"}`}
					aria-label="主导航"
				>
					{NAV.map((item) => (
						<Link
							key={item.to}
							to={item.to}
							className="nav-link min-h-11 inline-flex items-center"
							activeProps={{ className: "nav-link is-active" }}
							activeOptions={{ exact: item.to === "/" }}
						>
							{item.label}
						</Link>
					))}
				</nav>
			</div>
		</header>
	);
}

/**
 * The footer.
 *
 * Holds the keyboard reference, which used to sit in the workspace toolbar and
 * competed with the task controls for attention. A footer is also reachable on
 * touch, where a hover-only tooltip would not be.
 */
export function SiteFooter() {
	return (
		<footer className="mt-auto border-t border-border">
			<div className="mx-auto w-full max-w-6xl px-4 py-4 text-muted-foreground text-xs md:px-6">
				<p>
					快捷键：<kbd>Ctrl/⌘</kbd> + <kbd>Enter</kbd> 立即翻译 ·{" "}
					<kbd>Ctrl/⌘</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd> 交换语言 ·{" "}
					<kbd>Esc</kbd> 关闭弹层
				</p>
				<p className="mt-2">
					密钥仅保存在本浏览器，直接发送到你自己配置的模型端点。
				</p>
			</div>
		</footer>
	);
}
