import type { ChangeEvent, DragEvent } from "react";

interface DocumentDropZoneProps {
	readonly disabled?: boolean;
	readonly onAccept: (file: File) => void;
	readonly onReject: (message: string) => void;
}

const ACCEPT = ".docx,.pdf,.pptx,.xlsx";

/** File input and drop target for the one-file document flow. */
export function DocumentDropZone({
	disabled = false,
	onAccept,
	onReject,
}: DocumentDropZoneProps) {
	function acceptFiles(files: FileList | readonly File[]): void {
		const file = files[0];
		if (file === undefined) return;
		onAccept(file);
	}

	function onChange(event: ChangeEvent<HTMLInputElement>): void {
		if (event.target.files) acceptFiles(event.target.files);
		event.target.value = "";
	}

	function onDrop(event: DragEvent<HTMLLabelElement>): void {
		event.preventDefault();
		if (disabled) return;
		if (event.dataTransfer.files.length === 0) {
			onReject("请拖入一个文档文件。");
			return;
		}
		acceptFiles(event.dataTransfer.files);
	}

	return (
		<label
			htmlFor="document-file"
			className="rounded-md border border-dashed border-border bg-surface p-4"
			onDragOver={(event) => event.preventDefault()}
			onDrop={onDrop}
		>
			<p className="text-sm">拖入文档，或选择一个文件开始翻译。</p>
			<p className="mt-2 text-muted-foreground text-xs">
				支持 .docx、.pdf、.pptx、.xlsx，单文件上限 20 MB。
			</p>
			<span className="mt-4 inline-flex min-h-11 cursor-pointer items-center rounded-sm border border-border px-4 text-xs">
				选择文档
				<input
					disabled={disabled}
					className="sr-only"
					id="document-file"
					name="document-file"
					type="file"
					accept={ACCEPT}
					onChange={onChange}
				/>
			</span>
		</label>
	);
}
