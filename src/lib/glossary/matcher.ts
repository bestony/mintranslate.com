/** Aho-Corasick matching for glossary terms. */

import {
	type GlossaryMatch,
	type GlossaryTerm,
	isCjkLanguage,
	isLatinLanguage,
	type LanguagePair,
	normalizeSource,
	termAppliesToPair,
} from "./model";

interface Pattern {
	readonly term: GlossaryTerm;
	readonly units: readonly string[];
	readonly caseSensitive: boolean;
}

interface Node {
	readonly next: Map<string, number>;
	fail: number;
	readonly outputs: number[];
}

interface Candidate {
	readonly pattern: Pattern;
	readonly startUnit: number;
	readonly endUnit: number;
}

function sourceForMatch(term: GlossaryTerm): string {
	const compact = term.source.trim().replace(/\s+/g, " ");
	return term.caseSensitive ? compact : normalizeSource(compact);
}

function lowerUnit(unit: string): string {
	return unit.toLowerCase();
}

function isWordUnit(unit: string | undefined): boolean {
	return unit !== undefined && /^[\p{Script=Latin}\p{N}_]$/u.test(unit);
}

function containsCjk(text: string): boolean {
	return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text);
}

function patternNeedsBoundary(pattern: Pattern, pair: LanguagePair): boolean {
	if (isCjkLanguage(pattern.term.sl)) return false;
	if (isLatinLanguage(pattern.term.sl)) return true;
	if (pattern.term.sl.toLowerCase() === "auto") {
		if (isLatinLanguage(pair.sl)) return true;
		if (containsCjk(pattern.term.source)) return false;
		return /^[\p{L}\p{N}_ -]+$/u.test(pattern.term.source);
	}
	return false;
}

function hasBoundary(
	units: readonly string[],
	startUnit: number,
	endUnit: number,
): boolean {
	return !isWordUnit(units[startUnit - 1]) && !isWordUnit(units[endUnit + 1]);
}

/** Compiled machine containing both case-sensitive and folded patterns. */
export class GlossaryAutomaton {
	private readonly patterns: readonly Pattern[];
	private readonly nodes: readonly Node[];

	public constructor(
		terms: readonly GlossaryTerm[],
		private readonly pair: LanguagePair,
	) {
		this.patterns = terms
			.filter((term) => termAppliesToPair(term, pair))
			.map((term) => {
				const source = sourceForMatch(term);
				return {
					term,
					units: Array.from(source),
					caseSensitive: term.caseSensitive,
				};
			})
			.filter((pattern) => pattern.units.length > 0);

		const nodes: Node[] = [{ next: new Map(), fail: 0, outputs: [] }];
		for (const [patternIndex, pattern] of this.patterns.entries()) {
			let nodeIndex = 0;
			for (const unit of pattern.units) {
				const key = pattern.caseSensitive ? unit : lowerUnit(unit);
				const existing = nodes[nodeIndex].next.get(key);
				if (existing !== undefined) {
					nodeIndex = existing;
					continue;
				}
				const created = nodes.length;
				nodes.push({ next: new Map(), fail: 0, outputs: [] });
				nodes[nodeIndex].next.set(key, created);
				nodeIndex = created;
			}
			nodes[nodeIndex].outputs.push(patternIndex);
		}

		const queue: number[] = [];
		for (const child of nodes[0].next.values()) {
			nodes[child].fail = 0;
			queue.push(child);
		}
		for (let head = 0; head < queue.length; head += 1) {
			const nodeIndex = queue[head];
			for (const [key, child] of nodes[nodeIndex].next) {
				queue.push(child);
				let fallback = nodes[nodeIndex].fail;
				while (fallback !== 0 && !nodes[fallback].next.has(key)) {
					fallback = nodes[fallback].fail;
				}
				const edge = nodes[fallback].next.get(key);
				nodes[child].fail = edge !== undefined && edge !== child ? edge : 0;
				nodes[child].outputs.push(...nodes[nodes[child].fail].outputs);
			}
		}
		this.nodes = nodes;
	}

	/** Number of patterns in this machine. */
	public get patternCount(): number {
		return this.patterns.length;
	}

	/** Scan text once and choose the leftmost-longest non-overlapping matches. */
	public match(text: string): GlossaryMatch[] {
		if (text === "" || this.patterns.length === 0) return [];

		const units = Array.from(text);
		const candidates = [
			...this.scanPass(units, true),
			...this.scanPass(units.map(lowerUnit), false),
		];

		candidates.sort((left, right) => {
			const start = left.startUnit - right.startUnit;
			if (start !== 0) return start;
			const length = right.pattern.units.length - left.pattern.units.length;
			if (length !== 0) return length;
			const priority = right.pattern.term.priority - left.pattern.term.priority;
			if (priority !== 0) return priority;
			return left.pattern.term.id.localeCompare(right.pattern.term.id);
		});

		const selected: GlossaryMatch[] = [];
		let nextFreeUnit = 0;
		const unitOffsets = unitOffsetsFor(text, units);
		for (const candidate of candidates) {
			if (candidate.startUnit < nextFreeUnit) continue;
			const startOffset = unitOffsets[candidate.startUnit];
			const endOffset = unitOffsets[candidate.endUnit + 1];
			if (startOffset === undefined || endOffset === undefined) continue;
			const term = candidate.pattern.term;
			selected.push({
				term,
				start: startOffset,
				end: endOffset,
				index: startOffset,
				position: startOffset,
				source: text.slice(startOffset, endOffset),
				matchedText: text.slice(startOffset, endOffset),
				target: term.target,
				priority: term.priority,
			});
			nextFreeUnit = candidate.endUnit + 1;
		}
		return selected;
	}

	private scanPass(
		units: readonly string[],
		acceptCaseSensitive: boolean,
	): Candidate[] {
		const candidates: Candidate[] = [];
		let state = 0;
		for (let endUnit = 0; endUnit < units.length; endUnit += 1) {
			const unit = units[endUnit];
			while (state !== 0 && !this.nodes[state].next.has(unit)) {
				state = this.nodes[state].fail;
			}
			state = this.nodes[state].next.get(unit) ?? 0;
			for (const patternIndex of this.nodes[state].outputs) {
				const pattern = this.patterns[patternIndex];
				if (pattern.caseSensitive !== acceptCaseSensitive) continue;
				const startUnit = endUnit - pattern.units.length + 1;
				if (startUnit < 0) continue;
				if (
					patternNeedsBoundary(pattern, this.pair) &&
					!hasBoundary(units, startUnit, endUnit)
				)
					continue;
				candidates.push({ pattern, startUnit, endUnit });
			}
		}
		return candidates;
	}
}

function unitOffsetsFor(text: string, units: readonly string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (const unit of units) {
		offsets.push(offset);
		offset += unit.length;
	}
	offsets.push(text.length);
	return offsets;
}

/** Compile and match a term list without touching IndexedDB. */
export function matchGlossaryTerms(
	text: string,
	pair: LanguagePair,
	terms: readonly GlossaryTerm[],
): GlossaryMatch[] {
	return new GlossaryAutomaton(terms, pair).match(text);
}
