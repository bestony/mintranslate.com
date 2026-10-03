/** Public document translation surface. */

export {
	completedChunkCount,
	type DocumentFormat,
	type DocumentTaskRecord,
	MAX_DOCUMENT_BYTES,
	TASK_BYTE_THRESHOLD,
	TASK_PAGE_THRESHOLD,
} from "./model";
export {
	chunksFromPdfExtraction,
	extractPdfText,
	type PdfExtraction,
	type PdfExtractionPage,
} from "./pdf";
export {
	buildComparisonText,
	deliveredFileName,
	EMPTY_DOCUMENT_NOTICE,
	layoutDisclosure,
	needsLayoutDisclosure,
} from "./result";
export { runDocumentJob } from "./runner";
export { progressOf, resetResultsForContext, resultsAreReusable } from "./task";
export {
	type DocumentTranslationDeps,
	type DocumentTranslationOutcome,
	type DocumentTranslationRequest,
	documentLimiterFor,
	translateDocument,
} from "./translation";
export {
	describeBytes,
	TASK_THRESHOLDS,
	taskThresholdNotice,
	taskTrigger,
	unparsableReason,
	validateDocument,
} from "./validate";
