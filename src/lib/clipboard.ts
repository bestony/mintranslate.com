import { toast } from "sonner";

export async function copyToClipboard(
	text: string,
	t: (key: string, options?: Record<string, unknown>) => string,
) {
	const content = text.trim();
	if (!content) return;

	try {
		if (globalThis.navigator?.clipboard?.writeText) {
			await globalThis.navigator.clipboard.writeText(content);
			toast.success(t("common.toasts.copied"));
			return;
		}

		const textarea = globalThis.document?.createElement?.("textarea");
		if (!textarea) throw new Error("Clipboard API unavailable");
		textarea.value = content;
		textarea.setAttribute("readonly", "");
		textarea.style.position = "fixed";
		textarea.style.top = "-9999px";
		textarea.style.left = "-9999px";
		globalThis.document.body.appendChild(textarea);
		textarea.select();
		const ok = globalThis.document.execCommand?.("copy");
		textarea.remove();
		if (!ok) throw new Error("Copy failed");
		toast.success(t("common.toasts.copied"));
	} catch {
		toast.error(t("common.toasts.copyFailed"));
	}
}
