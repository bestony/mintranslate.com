/**
 * Image translation public surface.
 *
 * A barrel so components import from one place and the internal file layout stays
 * free to change. Only what the UI and the analysis pipeline need is exported;
 * the canvas environment and worker entry stay internal.
 */

export {
	createImageTranslator,
	IMAGE_RETRY_LIMITS,
	type ImageTranslationDeps,
	type ImageTranslationOutcome,
	type ImageTranslationRequest,
	type ImageTranslator,
} from "./controller";
export {
	type ClipboardItemLike,
	candidatesFromFiles,
	clipboardHasImage,
	DROP_STATES,
	type DropState,
	type DropStateView,
	dragLooksAcceptable,
	dropStateView,
	type FileLike,
	type IntakeResult,
	imageFromClipboard,
} from "./intake";
export {
	MODE_URL_VALUES,
	modeFromUrl,
	urlValueForMode,
	WORKSPACE_MODES,
	type WorkspaceMode,
} from "./mode";
export {
	ACCEPTED_IMAGE_EXTENSIONS,
	ACCEPTED_IMAGE_MIME_TYPES,
	type Dimensions,
	type ImageBytes,
	type ImageRegion,
	isLocatable,
	MAX_IMAGE_BYTES,
	MAX_SENT_BYTES,
	MAX_SENT_EDGE_PX,
	type NormalizedBox,
	type ProcessedImage,
} from "./model";
export { isEmptyResult, type ParseResult, parseRegions } from "./parse";
export {
	type DecodedImage,
	type ImageEnvironment,
	PREPROCESS_LIMITS,
	preprocessImage,
} from "./preprocess";
export {
	acceptsCancel,
	IMAGE_STAGES,
	type ImageStage,
	isBusy,
	type ProgressView,
	progressView,
	SLOW_RUN_THRESHOLD_MS,
	type SlowRunChoice,
} from "./progress";

export {
	assembleImagePrompt,
	IMAGE_PROMPT_LIMITS,
	type ImagePrompt,
	orderGlossaryTerms,
	renderGlossarySection,
} from "./prompt";
export {
	type EncodePlan,
	encodeAttempts,
	hasMoreAttempts,
	scaleToFit,
} from "./resize";
export { type PreprocessRunnerDeps, preprocessWithFallback } from "./runner";
export {
	describeBytes,
	type ImageCandidate,
	type ValidationResult,
	validateImageCandidate,
} from "./validate";
