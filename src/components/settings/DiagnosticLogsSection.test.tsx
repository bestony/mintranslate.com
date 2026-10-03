/**
 * DiagnosticLogsSection tests.
 *
 * @vitest-environment jsdom
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_DIAGNOSTIC_DURATION_MS,
	startDiagnosticSession,
	stopDiagnosticSession,
} from "#/lib/logger/diagnostic";
import { DiagnosticLogsSection } from "./DiagnosticLogsSection";

describe("DiagnosticLogsSection", () => {
	it("renders title, inactive status badge, and start button when idle", () => {
		stopDiagnosticSession();
		const html = renderToString(<DiagnosticLogsSection />);

		expect(html).toContain("运行与诊断日志");
		expect(html).toContain("未开启");
		expect(html).toContain("开启诊断日志 (5 分钟)");
		expect(html).toContain("下载最近 5 分钟日志");
		expect(html).toContain("清空日志");
	});

	it("renders active recording badge and stop button when session is active", () => {
		startDiagnosticSession(DEFAULT_DIAGNOSTIC_DURATION_MS);
		const html = renderToString(<DiagnosticLogsSection />);

		expect(html).toContain("记录中");
		expect(html).toContain("停止记录");
		stopDiagnosticSession();
	});
});
