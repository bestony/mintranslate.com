/**
 * Prompt assembly for image translation.
 *
 * Why this exists instead of calling `assemblePrompt`:
 *
 * `assemblePrompt` ends its system instruction with `"Return only the
 * translation."`, which contradicts an image call — the image path needs a
 * structured region list, not a single string. Its glossary rendering
 * (`glossaryBlock`) is module-private, and that file is being edited on another
 * workstream, so this module cannot reuse it either.
 *
 * So the glossary section is rendered here too, in the same format, and a test
 * compares the two outputs byte for byte. If the formats ever drift, that test
 * fails and the fix is to export the shared function and delete this copy (see
 * design.md, Resolved Decisions item 3).
 */

import type { GlossaryPromptTerm } from "#/lib/connections/styles";

/** Maximum glossary entries injected, matching `assemblePrompt`. */
const MAX_INJECTED_TERMS = 50;

/** Everything the image prompt needs. */
export interface ImagePromptOptions {
	/** Style description, already resolved by the caller. */
	readonly styleLabel?: string;
	readonly styleDescription?: string;
	readonly customInstruction?: string;
	readonly glossaryMatches?: readonly GlossaryPromptTerm[];
	/** What the user asked for, in words, e.g. the target language name. */
	readonly targetLanguageLabel: string;
	readonly sourceLanguageLabel?: string;
}

/** The two parts of a request. */
export interface ImagePrompt {
	readonly systemInstruction: string;
	readonly userContent: string;
}

/** Position used to order same-priority terms, mirroring `assemblePrompt`. */
function promptPosition(term: GlossaryPromptTerm, fallback: number): number {
	return term.index ?? term.start ?? term.position ?? fallback;
}

/**
 * Order and cap glossary terms exactly as `assemblePrompt` does.
 *
 * Priority first, then position; capped so a large glossary cannot crowd out the
 * task description.
 */
export function orderGlossaryTerms(
	terms: readonly GlossaryPromptTerm[],
): readonly GlossaryPromptTerm[] {
	return terms
		.map((term, originalIndex) => ({ term, originalIndex }))
		.sort((left, right) => {
			const priority = (right.term.priority ?? 0) - (left.term.priority ?? 0);
			if (priority !== 0) return priority;
			return (
				promptPosition(left.term, left.originalIndex) -
				promptPosition(right.term, right.originalIndex)
			);
		})
		.map(({ term }) => term)
		.slice(0, MAX_INJECTED_TERMS);
}

/**
 * Render the glossary section.
 *
 * Byte-identical to `assemblePrompt`'s rendering for the same ordered terms —
 * enforced by `prompt.test.ts`.
 */
export function renderGlossarySection(
	terms: readonly GlossaryPromptTerm[],
): string {
	if (terms.length === 0) return "";
	return [
		"Glossary instructions (mandatory):",
		"Use the specified target term whenever the corresponding source term appears.",
		...terms.map((term) => `- ${term.source} => ${term.target}`),
	].join("\n");
}

/** The response shape the model is asked to produce. */
export const IMAGE_RESPONSE_CONSTRAINT = {
	type: "array",
	items: {
		type: "object",
		properties: {
			source: { type: "string" },
			target: { type: "string" },
			box: {
				type: "object",
				properties: {
					x: { type: "number" },
					y: { type: "number" },
					width: { type: "number" },
					height: { type: "number" },
				},
				required: ["x", "y", "width", "height"],
			},
			uncertain: { type: "boolean" },
		},
		required: ["source", "target", "uncertain"],
	},
} as const;

const RESPONSE_CONTRACT = [
	"Return ONLY a JSON array, with no prose before or after it.",
	"Each element describes one text region and has exactly these fields:",
	'  "source": the text exactly as it appears in the image, in the original language,',
	'  "target": that text translated into the target language,',
	'  "box": an object with "x", "y", "width", "height" as fractions of the image between 0 and 1, where 0,0 is the top-left,',
	'  "uncertain": true when you are not confident about the reading, otherwise false.',
	'If you cannot locate a region precisely, omit its "box" rather than guessing.',
	"Do not merge separate regions into one entry, and do not invent text that is not visible.",
].join("\n");

/**
 * Build the request for an image translation.
 *
 * The user side carries the glossary section, the optional custom instruction and
 * the task line, in that order — matching how `assemblePrompt` composes its user
 * side, so a reviewer comparing the two sees the same arrangement.
 */
export function assembleImagePrompt(options: ImagePromptOptions): ImagePrompt {
	const style = [
		"You are a professional translation engine with vision.",
		options.styleLabel !== undefined
			? `Apply this translation style: ${options.styleLabel}${
					options.styleDescription !== undefined
						? ` — ${options.styleDescription}`
						: ""
				}`
			: undefined,
		RESPONSE_CONTRACT,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	const terms = orderGlossaryTerms(options.glossaryMatches ?? []);
	const glossary = renderGlossarySection(terms);
	const custom = options.customInstruction?.trim() ?? "";

	const task =
		options.sourceLanguageLabel !== undefined
			? `Read all text visible in this image (detect the language if needed; it is expected to be ${options.sourceLanguageLabel}) and translate it into ${options.targetLanguageLabel}.`
			: `Read all text visible in this image (detect its language) and translate it into ${options.targetLanguageLabel}.`;

	const userContent = [glossary, custom, task]
		.filter((part) => part !== "")
		.join("\n\n");

	return { systemInstruction: style, userContent };
}

/** For diagnostics, without importing the logger into a pure module. */
export const IMAGE_PROMPT_LIMITS = { maxInjectedTerms: MAX_INJECTED_TERMS };
