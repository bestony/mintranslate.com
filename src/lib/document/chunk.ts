/**
 * Chunking.
 *
 * The requirement is that a chunk boundary falls on a paragraph or a sentence and
 * never cuts a sentence. That ordering is deliberate: paragraphs are the natural
 * unit, and splitting inside one is a concession only made when the paragraph is
 * too long for a single call.
 *
 * Sentence splitting is conservative on purpose. There is no sentence-segmentation
 * library here, and adding one for four document formats would be disproportionate;
 * so a sentence boundary is only recognised at an unambiguous terminator (CJK full
 * stop, ASCII `.`/`!`/`?` followed by whitespace or end). A missed boundary makes a
 * chunk slightly larger, which costs nothing; a wrong boundary cuts a sentence,
 * which the requirement forbids.
 */

import {
	type ChunkLocation,
	MAX_CHUNK_CHARACTERS,
	type TextChunk,
} from "./model";

/** Characters that end a sentence in CJK text. */
const CJK_TERMINATORS = "。！？；";

/** Latin terminators, which only end a sentence when followed by a break. */
const LATIN_TERMINATORS = ".!?";

/**
 * Split text into sentences.
 *
 * Returns the whole text as one sentence when no boundary is recognised, which is
 * the correct outcome for a paragraph without terminator punctuation.
 *
 * The whitespace after a terminator stays with the following sentence rather than
 * trailing the previous one. Either convention is lossless — the parts always
 * concatenate back to the input — and this one keeps each part starting at the
 * sentence it belongs to.
 */
export function splitSentences(text: string): string[] {
	const sentences: string[] = [];
	let current = "";

	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		current += character;

		const isCjkEnd = CJK_TERMINATORS.includes(character);
		const isLatinEnd = LATIN_TERMINATORS.includes(character);

		if (!isCjkEnd && !isLatinEnd) continue;

		// For a Latin terminator, require a following break so that "3.5" and
		// "example.com" are not treated as sentence ends.
		if (isLatinEnd) {
			const next = text[index + 1];
			if (
				next !== undefined &&
				next !== " " &&
				next !== "\n" &&
				next !== "\t"
			) {
				continue;
			}
		}

		sentences.push(current);
		current = "";
	}

	if (current !== "") sentences.push(current);
	return sentences.filter((sentence) => sentence !== "");
}

/**
 * Split one paragraph into chunks that respect the size limit.
 *
 * Sentences are packed until adding the next would exceed the limit. A single
 * sentence longer than the limit is emitted as its own chunk rather than cut: an
 * oversized chunk can still be translated, whereas a cut sentence cannot be
 * translated correctly.
 */
export function chunkParagraph(
	text: string,
	location: ChunkLocation,
): TextChunk[] {
	const trimmed = text;
	if (trimmed.length <= MAX_CHUNK_CHARACTERS) {
		return [{ id: idFor(location), text: trimmed, location }];
	}

	const sentences = splitSentences(trimmed);
	const chunks: TextChunk[] = [];
	let buffer = "";
	let segment = 0;

	const flush = () => {
		if (buffer === "") return;
		chunks.push({
			id: idFor({ ...location, segment }),
			text: buffer,
			location: { ...location, segment },
		});
		buffer = "";
		segment += 1;
	};

	for (const sentence of sentences) {
		if (
			buffer !== "" &&
			buffer.length + sentence.length > MAX_CHUNK_CHARACTERS
		) {
			flush();
		}
		buffer += sentence;
	}
	flush();

	return chunks;
}

/** Chunk id, stable for a given location. */
function idFor(location: ChunkLocation): string {
	const anchor = location.part ?? `page:${location.page ?? 0}`;
	return `${anchor}:${location.paragraph}:${location.segment}`;
}

/**
 * Chunk every paragraph of a parsed document.
 *
 * Paragraphs that already fit become one chunk each, so the common case produces no
 * splitting at all and the segment index stays 0.
 */
export function chunkDocument(
	paragraphs: readonly {
		readonly text: string;
		readonly location: ChunkLocation;
	}[],
): TextChunk[] {
	const chunks: TextChunk[] = [];
	for (const paragraph of paragraphs) {
		chunks.push(...chunkParagraph(paragraph.text, paragraph.location));
	}
	return chunks;
}

/**
 * Reassemble the text a set of chunks covers.
 *
 * Used to assert that chunking is lossless: concatenating the chunks of one
 * paragraph must give back that paragraph.
 */
export function joinChunks(chunks: readonly TextChunk[]): string {
	return chunks.map((chunk) => chunk.text).join("");
}

/**
 * Group chunks back by their paragraph.
 *
 * Writing a result back needs one value per paragraph, so a paragraph split into
 * several chunks is reassembled before writing.
 */
export function groupByParagraph(
	chunks: readonly TextChunk[],
): Map<string, TextChunk[]> {
	const groups = new Map<string, TextChunk[]>();
	for (const chunk of chunks) {
		const anchor = chunk.location.part ?? `page:${chunk.location.page ?? 0}`;
		const key = `${anchor}:${chunk.location.paragraph}`;
		const list = groups.get(key) ?? [];
		list.push(chunk);
		groups.set(key, list);
	}
	return groups;
}

/** Whether a chunk is part of a paragraph that was split. */
export function isSplitParagraph(chunks: readonly TextChunk[]): boolean {
	return chunks.length > 1;
}
