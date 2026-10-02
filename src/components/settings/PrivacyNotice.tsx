/**
 * Privacy notice for anonymous usage statistics.
 *
 * Rendered inside the application, not behind an external link: the requirement is
 * that a user who never leaves the app can still learn what is collected, where it
 * goes, and how to turn it off.
 *
 * The content is written to match what the code actually sends — see
 * `src/lib/analytics/events.ts` for the authoritative list and
 * `docs/analytics-events.md` for the fuller inventory.
 */

import { ANALYTICS_EVENT_NAMES } from "#/lib/analytics/events";

interface PrivacyNoticeProps {
	readonly open: boolean;
	readonly onToggle: () => void;
}

/** Human-readable purpose per event, so the list is not just event names. */
const EVENT_PURPOSES: Record<(typeof ANALYTICS_EVENT_NAMES)[number], string> = {
	app_open: "应用是否被打开，以及从哪种模式进入",
	translate_submit: "翻译请求的数量与输入长度（仅字符数）",
	translate_success: "翻译成功率与耗时",
	translate_error: "失败类型分布，用于定位卡点",
	lang_change: "语言方向的使用偏好",
	provider_config_save: "供应商配置是否顺利",
	connection_test: "连接测试的通过率与失败原因",
	cors_blocked: "哪些供应商在浏览器直连下不可用",
	model_in_use: "实际使用的厂商与模型",
};

export function PrivacyNotice({ open, onToggle }: PrivacyNoticeProps) {
	return (
		<div className="mt-3">
			<button
				type="button"
				className="nav-link text-sm"
				aria-expanded={open}
				onClick={onToggle}
			>
				{open ? "收起隐私说明" : "查看隐私说明"}
			</button>

			{open && (
				<div className="mt-2 rounded-md border border-line bg-surface/60 p-3 text-muted-foreground text-xs">
					<p className="font-medium text-foreground">采集什么</p>
					<p className="mt-1">仅匿名使用统计，包含以下事件：</p>
					<ul className="mt-1 list-disc space-y-0.5 pl-5">
						{ANALYTICS_EVENT_NAMES.map((name) => (
							<li key={name}>{EVENT_PURPOSES[name]}</li>
						))}
					</ul>

					<p className="mt-3 font-medium text-foreground">不采集什么</p>
					<p className="mt-1">
						原文、译文、图片与文档内容、被抓取网页内容、API Key 与任何密钥、完整
						Endpoint
						地址、自定义提示词与术语表内容，以及历史与反馈记录。页面地址在上报前会移除其中的原文参数。
					</p>

					<p className="mt-3 font-medium text-foreground">发送到哪里</p>
					<p className="mt-1">
						数据发送到 Google Analytics 4。未配置测量 ID
						时（例如内网部署）不会加载任何统计脚本，也不会产生任何请求。
					</p>

					<p className="mt-3 font-medium text-foreground">如何关闭</p>
					<p className="mt-1">
						关闭上方的「匿名使用统计」开关即可。关闭后立即停止发送，并清理已写入的统计
						cookie；刷新后也不会重新加载。
					</p>
				</div>
			)}
		</div>
	);
}
