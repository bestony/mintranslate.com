/**
 * Translation style and custom instruction.
 *
 * Scope note: this module defines how a style is *selected and assembled*. The
 * actual translation system prompt belongs to the `core-translation` change.
 *
 * The security-relevant rule lives here: a custom instruction is appended to
 * the user message only. It never replaces or edits the system-level
 * instruction, so a user instruction cannot disable the application's own
 * constraints.
 */

import type { GlossaryMatch } from "../glossary";
import { logger } from "../logger";

export const MAX_CUSTOM_INSTRUCTION_LENGTH = 500;

/** Built-in styles, in the order the PRD lists them. */
export const TRANSLATION_STYLES = [
	{ id: "literal", label: "直译", description: "贴近原文字面结构，逐句对应。" },
	{ id: "free", label: "意译", description: "以通顺自然为先，可调整句式。" },
	{ id: "formal", label: "正式", description: "书面语体，适合公文与商务。" },
	{ id: "colloquial", label: "口语", description: "日常口语语体，轻松自然。" },
	{
		id: "technical",
		label: "技术文档",
		description: "保留术语与技术名词的准确译法。",
	},
] as const;

export type TranslationStyleId = (typeof TRANSLATION_STYLES)[number]["id"];

/** Whether a value is a known style id. */
export function isTranslationStyleId(
	value: unknown,
): value is TranslationStyleId {
	return (
		typeof value === "string" &&
		TRANSLATION_STYLES.some((style) => style.id === value)
	);
}

export const DEFAULT_STYLE_ID: TranslationStyleId = "free";

/** Result of accepting a custom-instruction edit. */
export type InstructionEditResult =
	| { readonly kind: "accepted"; readonly value: string }
	| {
			readonly kind: "rejected";
			readonly value: string;
			readonly reason: string;
	  };

/**
 * Accept an edit to the custom instruction, or reject it without truncating.
 *
 * Rejecting rather than truncating is the requirement: silently dropping the
 * user's text would hide that part of their instruction is not in effect.
 */
export function acceptCustomInstruction(input: string): InstructionEditResult {
	if (input.length > MAX_CUSTOM_INSTRUCTION_LENGTH) {
		return {
			kind: "rejected",
			value: input.slice(0, MAX_CUSTOM_INSTRUCTION_LENGTH),
			reason: `自定义指令上限为 ${MAX_CUSTOM_INSTRUCTION_LENGTH} 个字符，超出部分未被接受。`,
		};
	}

	return { kind: "accepted", value: input };
}

/** The two parts of a request the assembler produces. */
export interface AssembledPrompt {
	/** Application-owned instruction. Never influenced by user input. */
	readonly systemInstruction: string;
	/** User-side content: the custom instruction plus the text to translate. */
	readonly userContent: string;
	/** All glossary matches supplied by the caller, ordered for display. */
	readonly glossaryMatches: readonly GlossaryPromptTerm[];
	/** Matches actually included in the prompt after the injection cap. */
	readonly injectedGlossaryMatches: readonly GlossaryPromptTerm[];
	/** Similar translations supplied as optional examples, never mandatory rules. */
	readonly memoryReferences: readonly TranslationMemoryPromptReference[];
	readonly injectedMemoryReferences: readonly TranslationMemoryPromptReference[];
}

/** Structural glossary data accepted by prompt assembly. */
export type GlossaryPromptTerm = Pick<GlossaryMatch, "source" | "target"> &
	Partial<
		Pick<GlossaryMatch, "index" | "position" | "start" | "end" | "priority">
	>;

/** Structural reference data accepted by prompt assembly. */
export interface TranslationMemoryPromptReference {
	readonly source: string;
	readonly target: string;
	readonly score?: number;
}

function promptPosition(term: GlossaryPromptTerm, fallback: number): number {
	return term.index ?? term.start ?? term.position ?? fallback;
}

function glossaryBlock(terms: readonly GlossaryPromptTerm[]): string {
	if (terms.length === 0) return "";
	return [
		"Glossary instructions (mandatory):",
		"Use the specified target term whenever the corresponding source term appears.",
		...terms.map(
			(term) => `- ${promptValue(term.source)} => ${promptValue(term.target)}`,
		),
	].join("\n");
}

function promptValue(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n");
}

function referenceBlock(
	references: readonly TranslationMemoryPromptReference[],
): string {
	if (references.length === 0) return "";
	return [
		"Translation memory references (for reference only):",
		"Use these examples as optional guidance; glossary instructions remain mandatory and these references are not rules.",
		...references.map(
			(reference) =>
				`- ${promptValue(reference.source)} => ${promptValue(reference.target)}`,
		),
	].join("\n");
}

/**
 * Assemble the request parts for a translation.
 *
 * `systemInstruction` is produced by the application from the selected style
 * only. The custom instruction is placed on the user side, so no user input can
 * escalate into the system instruction.
 */
export function assemblePrompt(options: {
	readonly styleId: TranslationStyleId;
	readonly customInstruction?: string;
	readonly text: string;
	readonly glossaryMatches?: readonly GlossaryPromptTerm[];
	/** Alias retained for callers that use the data model name. */
	readonly glossaryTerms?: readonly GlossaryPromptTerm[];
	/** Short alias for integrations that already call the section glossary. */
	readonly glossary?: readonly GlossaryPromptTerm[];
	readonly memoryReferences?: readonly TranslationMemoryPromptReference[];
	/** Alias for integrations that call the section reference translations. */
	readonly referenceTranslations?: readonly TranslationMemoryPromptReference[];
}): AssembledPrompt {
	const style = TRANSLATION_STYLES.find(
		(entry) => entry.id === options.styleId,
	);
	const styleLabel = style?.label ?? "意译";
	const styleDescription = style?.description ?? "";

	const systemInstruction = [
		"You are a professional translation engine.",
		`Apply this translation style: ${styleLabel} — ${styleDescription}`,
		"Return only the translation.",
	].join("\n");

	const providedMatches =
		options.glossaryMatches ?? options.glossaryTerms ?? options.glossary ?? [];
	const orderedMatches = providedMatches
		.map((term, originalIndex) => ({ term, originalIndex }))
		.sort((left, right) => {
			const priority = (right.term.priority ?? 0) - (left.term.priority ?? 0);
			if (priority !== 0) return priority;
			return (
				promptPosition(left.term, left.originalIndex) -
				promptPosition(right.term, right.originalIndex)
			);
		})
		.map(({ term }) => term);
	const injectedMatches = orderedMatches.slice(0, 50);
	const glossary = glossaryBlock(injectedMatches);
	const providedReferences =
		options.memoryReferences ?? options.referenceTranslations ?? [];
	const injectedReferences = providedReferences.slice(0, 3);
	const references = referenceBlock(injectedReferences);
	const custom = options.customInstruction?.trim() ?? "";
	const userContent =
		glossary === "" && references === ""
			? custom === ""
				? options.text
				: `${custom}\n\n${options.text}`
			: [glossary, references, custom, options.text]
					.filter((part) => part !== "")
					.join("\n\n");

	logger.debug("glossary.prompt.injected", {
		matchedCount: orderedMatches.length,
		injectedCount: injectedMatches.length,
		referenceCount: injectedReferences.length,
	});

	return {
		systemInstruction,
		userContent,
		glossaryMatches: orderedMatches,
		injectedGlossaryMatches: injectedMatches,
		memoryReferences: providedReferences,
		injectedMemoryReferences: injectedReferences,
	};
}
