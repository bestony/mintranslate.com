/**
 * Image translation mode.
 *
 * The whole mode lives here, behind one component, so the workspace only has to
 * mount it and pass the language pair. That keeps the workspace change to a single
 * insertion — which matters because that file is edited on another workstream.
 *
 * Everything it depends on already exists: the pipeline (`#/lib/image`), the
 * caller with its capability guard and call control, the logger, and the analytics
 * tracker the workspace hands down.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Analytics } from "#/lib/analytics/track";
import { createKeyedLimiters } from "#/lib/call-control/concurrency";
import type { Connection } from "#/lib/connections/model";
import type { GlossaryPromptTerm } from "#/lib/connections/styles";
import { listTerms, termAppliesToPair } from "#/lib/glossary";
import {
	acceptsCancel,
	createImageTranslator,
	type ImageRegion,
	type ImageStage,
	preprocessWithFallback,
	progressView,
	SLOW_RUN_THRESHOLD_MS,
} from "#/lib/image";
import { logger } from "#/lib/logger";
import { ImageDropZone } from "./ImageDropZone";
import { ImageResultView } from "./ImageResultView";

/** Per-connection limiter set, shared across the module's lifetime. */
const limiters = createKeyedLimiters(2);

interface ImageTranslationModeProps {
	/** The active connection, or undefined when none is usable. */
	readonly connection: Connection | undefined;
	/** Its key. Read at submit time, never stored. */
	readonly apiKey: string;
	readonly sourceLang: string;
	readonly targetLang: string;
	readonly sourceLanguageLabel?: string;
	readonly targetLanguageLabel: string;
	/** Style and instruction come from the same settings the text mode reads. */
	readonly styleLabel?: string;
	readonly styleDescription?: string;
	readonly customInstruction?: string;
	readonly analytics: Analytics;
	/** Called with the recognised source text when a result arrives. */
	readonly onResult?: (regions: readonly ImageRegion[]) => void;
}

/** A short stable digest, or undefined when the platform will not provide one. */
async function digestKey(bytes: Uint8Array): Promise<string | undefined> {
	try {
		if (globalThis.crypto?.subtle === undefined) return undefined;
		const hash = await globalThis.crypto.subtle.digest(
			"SHA-256",
			bytes as unknown as ArrayBuffer,
		);
		return Array.from(new Uint8Array(hash))
			.slice(0, 12)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	} catch {
		return undefined;
	}
}

export function ImageTranslationMode({
	connection,
	apiKey,
	sourceLang,
	targetLang,
	sourceLanguageLabel,
	targetLanguageLabel,
	styleLabel,
	styleDescription,
	customInstruction,
	analytics,
	onResult,
}: ImageTranslationModeProps) {
	const [stage, setStage] = useState<ImageStage>("idle");
	const [elapsedMs, setElapsedMs] = useState(0);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [regions, setRegions] = useState<readonly ImageRegion[]>([]);
	const [rawText, setRawText] = useState<string | undefined>(undefined);
	const [imageSrc, setImageSrc] = useState<string | undefined>(undefined);
	/** Natural size of the processed image, so it is never upscaled for display. */
	const [imageSize, setImageSize] = useState<
		{ width: number; height: number } | undefined
	>(undefined);
	const [waitedPast, setWaitedPast] = useState(false);

	const startedAt = useRef<number | undefined>(undefined);
	/** Submission counter, used as the dedupe key when content hashing is unavailable. */
	const submissionSeq = useRef(0);
	const objectUrl = useRef<string | undefined>(undefined);

	const translator = useMemo(
		() => createImageTranslator({ limiterFor: (id) => limiters.for(id) }),
		[],
	);

	/**
	 * Terms to inject, resolved once per run.
	 *
	 * Selected by language pair rather than by recognised text, because at this
	 * point there is no recognised text — the recognition happens in the same call
	 * as the translation (design D5a).
	 */
	const loadGlossaryTerms = useCallback(async (): Promise<
		readonly GlossaryPromptTerm[]
	> => {
		try {
			const pair = { sl: sourceLang, tl: targetLang };
			const loaded = await listTerms(pair);
			if (!loaded.ok) throw new Error(loaded.reason);

			return loaded.value
				.filter((term) => termAppliesToPair(term, pair))
				.map((term) => ({ source: term.source, target: term.target }));
		} catch (error) {
			// A glossary problem must not block a translation; the terms are an
			// enhancement, and their absence is logged rather than shown.
			logger.warn("image.mode.glossary.unavailable", {
				reason: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}, [sourceLang, targetLang]);

	// Ticks only while a run is in flight, so the elapsed value cannot keep growing
	// after completion and leave the slow notice on screen.
	useEffect(() => {
		if (stage !== "preparing" && stage !== "analyzing") return;
		const timer = setInterval(() => {
			setElapsedMs(
				startedAt.current === undefined ? 0 : Date.now() - startedAt.current,
			);
		}, 1000);
		return () => clearInterval(timer);
	}, [stage]);

	// Release the object URL when it is replaced or the mode goes away: a retained
	// blob URL keeps the whole image alive.
	useEffect(
		() => () => {
			if (objectUrl.current !== undefined) {
				URL.revokeObjectURL(objectUrl.current);
				objectUrl.current = undefined;
			}
		},
		[],
	);

	const progress = progressView(stage, elapsedMs);

	const submit = useCallback(
		async (file: File) => {
			setNotice(undefined);
			setRawText(undefined);
			setRegions([]);
			setStage("preparing");
			setElapsedMs(0);
			setWaitedPast(false);
			startedAt.current = Date.now();

			if (connection === undefined) {
				setStage("failed");
				setNotice("还没有可用的连接。请先在设置页配置一个支持图片输入的模型。");
				return;
			}

			const requestId = `img-${Date.now().toString(36)}`;

			try {
				const original = new Uint8Array(await file.arrayBuffer());
				const processed = await preprocessWithFallback({
					bytes: original,
					mimeType: file.type === "" ? "image/jpeg" : file.type,
				});

				logger.debug("image.mode.preprocessed", {
					requestId,
					width: processed.width,
					height: processed.height,
					originalBytes: processed.originalBytes,
					bytes: processed.bytes.byteLength,
					compressed: processed.compressed,
				});

				// Show the processed image: the overlay must align with what the model
				// analysed, not with the original file.
				const blob = new Blob([processed.bytes as unknown as BlobPart], {
					type: processed.mimeType,
				});
				const nextUrl = URL.createObjectURL(blob);
				if (objectUrl.current !== undefined)
					URL.revokeObjectURL(objectUrl.current);
				objectUrl.current = nextUrl;
				setImageSrc(nextUrl);
				setImageSize({
					width: processed.width,
					height: processed.height,
				});

				const glossaryMatches = await loadGlossaryTerms();
				if (glossaryMatches.length > 0) {
					logger.debug("image.mode.glossary.injected", {
						requestId,
						terms: glossaryMatches.length,
					});
				}

				const digest = await digestKey(processed.bytes);
				// Without a digest a fresh key per submission is used, which means no
				// merging rather than merging two different images by collision.
				submissionSeq.current += 1;
				const imageKey = digest ?? `seq:${submissionSeq.current}`;

				analytics.track("translate_submit", {
					mode: "images",
					source_lang: sourceLang,
					target_lang: targetLang,
					// Character counts describe the request; the image itself and any
					// recognised text are never sent.
					input_chars: 0,
					input_kind: "image",
				});

				setStage("analyzing");

				const outcome = await translator.translate({
					connection,
					apiKey,
					imageBase64: base64FromBytes(processed.bytes),
					imageMimeType: processed.mimeType,
					imageKey,
					targetLanguageLabel,
					sourceLanguageLabel,
					styleLabel,
					styleDescription,
					customInstruction,
					glossaryMatches,
					requestId,
				});

				if (outcome.kind === "refused") {
					setStage("failed");
					// A superseded run is not a failure the user should see; a new run is
					// already in flight and will replace this state.
					setNotice(
						outcome.kindReason === "superseded"
							? undefined
							: outcome.kindReason,
					);
					return;
				}

				if (outcome.kind === "failed") {
					setStage("failed");
					setNotice(outcome.attribution.summary);
					analytics.track("translate_error", {
						mode: "images",
						provider: connection.provider,
						model: connection.model,
						error_type: outcome.attribution.type,
					});
					return;
				}

				setRegions(outcome.regions);
				setRawText(outcome.rawText);
				setStage("done");
				setElapsedMs(Date.now() - (startedAt.current ?? Date.now()));

				analytics.track("translate_success", {
					mode: "images",
					source_lang: sourceLang,
					target_lang: targetLang,
					provider: connection.provider,
					model: connection.model,
					latency_ms: Date.now() - (startedAt.current ?? Date.now()),
					// Structured results arrive complete; there is no streaming path.
					is_streaming: false,
				});

				onResult?.(outcome.regions);
			} catch (error) {
				logger.warn("image.mode.failed", {
					requestId,
					reason: error instanceof Error ? error.message : String(error),
				});
				setStage("failed");
				setNotice(
					error instanceof Error ? error.message : "图片处理失败，请重试。",
				);
			}
		},
		[
			analytics,
			apiKey,
			connection,
			customInstruction,
			loadGlossaryTerms,
			onResult,
			sourceLang,
			sourceLanguageLabel,
			styleDescription,
			styleLabel,
			targetLang,
			targetLanguageLabel,
			translator,
		],
	);

	function cancel() {
		if (connection !== undefined) translator.cancel(connection.id);
		setStage("idle");
		setNotice(undefined);
		setElapsedMs(0);
		logger.debug("image.mode.cancelled", {});
	}

	return (
		<section className="flex min-h-0 flex-col" aria-label="图片翻译">
			<ImageDropZone
				disabled={progress.busy}
				onAccept={(file) => void submit(file)}
				onReject={setNotice}
			/>

			{notice !== undefined && (
				<p className="mt-4 text-sm" role="alert">
					{notice}
				</p>
			)}

			{progress.busy && (
				<div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
					<p aria-live="polite">{progress.label}</p>
					{progress.cancellable && (
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-4 text-xs"
							onClick={cancel}
						>
							取消
						</button>
					)}
				</div>
			)}

			{progress.slow && !waitedPast && (
				<div
					className="mt-4 rounded-md border border-border bg-surface p-4 text-sm"
					role="alert"
				>
					<p>
						这张图片的处理已超过 {Math.round(SLOW_RUN_THRESHOLD_MS / 1000)} 秒。
						可以继续等待，也可以取消后换一张更小的图片。
					</p>
					<div className="mt-2 flex flex-wrap gap-2">
						<button
							type="button"
							className="min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
							onClick={() => setWaitedPast(true)}
						>
							继续等待
						</button>
						<button
							type="button"
							className="min-h-11 rounded-sm border border-border px-4 text-xs"
							onClick={cancel}
						>
							取消
						</button>
					</div>
				</div>
			)}

			{/* The processed image is shown as soon as it exists, in every stage: a
			    failure still needs to show which image was attempted, and the result
			    view replaces this once there is something to render. */}
			{imageSrc !== undefined && stage !== "done" && (
				<img
					src={imageSrc}
					alt="待翻译的图片"
					// Capped at the natural size: stretching a small image past its own
					// resolution adds no detail and reads as blur.
					style={
						imageSize === undefined
							? undefined
							: { maxWidth: `min(100%, ${imageSize.width}px)` }
					}
					className="mt-4 max-h-[60vh] rounded-md border border-border"
				/>
			)}

			{imageSrc !== undefined && stage === "done" && (
				<ImageResultView
					regions={regions}
					imageSrc={imageSrc}
					naturalWidth={imageSize?.width}
					imageAlt="待翻译的图片，识别到的文字区域已在其上标出"
					rawText={rawText}
				/>
			)}
		</section>
	);
}

/** Base64 of bytes, without a data-URL prefix. */
function base64FromBytes(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(
			...bytes.subarray(index, Math.min(index + chunk, bytes.length)),
		);
	}
	return btoa(binary);
}

/** Exported for the tests' fake-timer cases. */
export { acceptsCancel };
