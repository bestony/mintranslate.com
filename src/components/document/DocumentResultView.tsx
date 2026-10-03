import type { DocumentFormat } from "#/lib/document/model";
import { EMPTY_DOCUMENT_NOTICE, layoutDisclosure } from "#/lib/document/result";

interface DocumentResultViewProps {
	readonly format?: DocumentFormat;
	readonly downloadUrl?: string;
	readonly downloadName?: string;
	readonly empty?: boolean;
	readonly notice?: string;
}

/** Delivery area. A PDF's layout disclosure is rendered before its link. */
export function DocumentResultView({
	format,
	downloadUrl,
	downloadName,
	empty = false,
	notice,
}: DocumentResultViewProps) {
	const disclosure =
		format === undefined ? undefined : layoutDisclosure(format);

	return (
		<section
			className="mt-4 rounded-md border border-border bg-surface p-4"
			aria-label="文档结果"
		>
			{notice !== undefined && (
				<p className="text-sm" role="alert">
					{notice}
				</p>
			)}
			{empty && (
				<output className="text-sm" aria-live="polite">
					{EMPTY_DOCUMENT_NOTICE}
				</output>
			)}
			{disclosure !== undefined && !empty && (
				<p className="text-sm" role="note">
					{disclosure}
				</p>
			)}
			{downloadUrl !== undefined && downloadName !== undefined && !empty && (
				<a
					className="mt-4 inline-flex min-h-11 items-center rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
					download={downloadName}
					href={downloadUrl}
				>
					下载 {downloadName}
				</a>
			)}
		</section>
	);
}
