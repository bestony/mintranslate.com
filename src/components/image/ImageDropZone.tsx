/**
 * Image intake surface.
 *
 * Three entries share one decision path: whatever arrives — a drop, a file, a paste
 * — becomes a candidate list, and validation decides from there. The component
 * holds only the interaction state (dragging, rejected, error), because that is
 * the part that genuinely lives in the DOM.
 *
 * Accessibility notes that are load-bearing rather than decoration:
 *
 * - the target is a real `<button>`-reachable control, so the file picker is
 *   reachable by keyboard;
 * - drop state changes are announced through text, not only through the border,
 *   because "you can drop this" and "you cannot" are opposite instructions;
 * - rejections are `role="alert"` so a screen reader hears the reason.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
	candidatesFromFiles,
	describeBytes,
	dragLooksAcceptable,
	dropStateView,
	type FileLike,
	imageFromClipboard,
	validateImageCandidate,
} from "#/lib/image";

interface ImageDropZoneProps {
	/** Called with an accepted file. Rejection is handled here. */
	readonly onAccept: (file: File) => void;
	/** Called when a candidate is refused, with the reason. */
	readonly onReject: (reason: string) => void;
	/** Disabled while a run is in flight. */
	readonly disabled?: boolean;
}

export function ImageDropZone({
	onAccept,
	onReject,
	disabled = false,
}: ImageDropZoneProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	/** Whether the current drag carries a file payload (`Files` in its types). */
	const [dragHasFiles, setDragHasFiles] = useState(false);

	/** Validate and forward one file, reporting refusals to the caller. */
	const accept = useCallback(
		(file: FileLike | File) => {
			const result = validateImageCandidate({
				name: file.name,
				type: file.type,
				size: file.size,
			});
			if (!result.ok) {
				onReject(result.reason);
				return;
			}
			onAccept(file as File);
		},
		[onAccept, onReject],
	);

	/** Handle a set of dropped or selected files. */
	const acceptAll = useCallback(
		(files: ArrayLike<FileLike> | undefined) => {
			const { candidates, empty } = candidatesFromFiles(files);
			if (empty) {
				onReject("没有读到文件，请重试或改用点击选择。");
				return;
			}
			// Only the first is processed: the spec's granularity is one image, and
			// silently ignoring the rest would be worse than saying so.
			if (candidates.length > 1) {
				onReject(
					`一次只处理一张图片，已取用第一张（共 ${candidates.length} 张）。`,
				);
			}
			accept(candidates[0]);
		},
		[accept, onReject],
	);

	// Paste is listened for on the window, because the user may not have focused the
	// drop target before pasting.
	useEffect(() => {
		if (disabled) return;

		function onPaste(event: ClipboardEvent) {
			const file = imageFromClipboard(
				event.clipboardData?.items as unknown as
					| Array<{
							kind: string;
							type: string;
							getAsFile?: () => File | null;
					  }>
					| undefined,
			);
			if (file === undefined) return;

			// Only when there is an image: otherwise the paste belongs to whatever
			// field the user is actually typing in.
			event.preventDefault();
			accept(file as File);
		}

		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, [accept, disabled]);

	// Invalid means "you are dragging something, and it is not a file" — the
	// opposite instruction from the active state, which is why they are distinct.
	const view = dropStateView(dragging, dragging && !dragHasFiles);

	return (
		<div className="mt-4">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target has no
			    semantic element and dragging has no keyboard equivalent, so the drag
			    handlers belong on the container. The keyboard path is the real button
			    inside it, which opens the file picker. */}
			<div
				// A raised drag state is border and background, never a shadow: the design
				// system is flat.
				className={[
					"flex min-h-60 flex-col items-center justify-center gap-2 rounded-md border-2 p-6 text-center",
					view.state === "active"
						? "border-primary-strong bg-surface"
						: view.state === "invalid"
							? "border-dashed border-muted-foreground bg-background"
							: "border-dashed border-border bg-surface",
				].join(" ")}
				onDragEnter={(event) => {
					event.preventDefault();
					if (disabled) return;
					setDragging(true);
					setDragHasFiles(
						dragLooksAcceptable(
							event.dataTransfer?.types as unknown as string[],
						),
					);
				}}
				onDragOver={(event) => {
					// Preventing the default on dragover is what makes a drop possible at
					// all; without it the browser navigates to the file.
					event.preventDefault();
				}}
				onDragLeave={(event) => {
					event.preventDefault();
					setDragging(false);
				}}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					if (disabled) return;
					acceptAll(
						event.dataTransfer?.files as unknown as ArrayLike<FileLike>,
					);
				}}
			>
				<p className="text-sm">{view.message}</p>

				<button
					type="button"
					className="min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-sm disabled:opacity-50"
					disabled={disabled}
					onClick={() => inputRef.current?.click()}
				>
					选择图片
				</button>

				<p className="text-muted-foreground text-xs">
					支持 jpg、jpeg、png、webp，单张不超过{" "}
					{describeBytes(10 * 1024 * 1024)}。也可以直接粘贴剪贴板中的图片。
				</p>

				<input
					ref={inputRef}
					id="image-file-input"
					name="image-file"
					aria-label="选择图片文件"
					type="file"
					accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
					className="sr-only"
					disabled={disabled}
					onChange={(event) => {
						acceptAll(event.target.files as unknown as ArrayLike<FileLike>);
						// Reset so choosing the same file twice still fires a change.
						event.target.value = "";
					}}
				/>

				{/* The drop state in text too: two opposite instructions must not be
				    distinguishable only by a border. */}
				<p className="sr-only" aria-live="polite">
					{view.state === "active"
						? "已进入可投放状态"
						: view.state === "invalid"
							? "当前内容不可投放"
							: ""}
				</p>
			</div>
		</div>
	);
}
