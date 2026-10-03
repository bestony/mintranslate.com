import type { BuiltinCreateMonitor } from "./capability";

/** Subscribe to the browser monitor's downloadprogress events. */
export function monitorBuiltinDownload(
	monitor: BuiltinCreateMonitor,
	onProgress: (progress: number) => void,
): void {
	monitor.addEventListener("downloadprogress", (event) => {
		const total = event.total ?? 1;
		if (!Number.isFinite(event.loaded) || !Number.isFinite(total) || total <= 0)
			return;
		onProgress(Math.max(0, Math.min(1, event.loaded / total)));
	});
}
