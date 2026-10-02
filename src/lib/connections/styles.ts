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

	const custom = options.customInstruction?.trim() ?? "";
	const userContent =
		custom === "" ? options.text : `${custom}\n\n${options.text}`;

	return { systemInstruction, userContent };
}
