/**
 * Language picker.
 *
 * A modal list with a search box. Keyboard-driven because picking a language is a
 * frequent, repetitive action: arrow keys move, `Enter` selects, `Esc` closes,
 * and typing anywhere jumps into the search field (so the user never has to aim
 * at it first).
 *
 * The list renders all twelve entries. Virtual scrolling is deliberately not
 * used — see the language inventory module for why (PRD §8.3's premise does not
 * hold for a fixed twelve-item list).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
	AUTO_DETECT,
	type Language,
	languageByCode,
	searchLanguages,
} from "#/lib/languages";

interface LanguagePickerProps {
	readonly open: boolean;
	/** Whether auto-detect may be chosen (source side only). */
	readonly allowAuto: boolean;
	readonly selected: string;
	readonly onSelect: (code: string) => void;
	readonly onClose: () => void;
}

/** The pseudo-entry for auto detection. */
const AUTO_ENTRY = {
	code: AUTO_DETECT,
	nameZh: "检测语言",
	nameEn: "Detect language",
} as const;

export function LanguagePicker({
	open,
	allowAuto,
	selected,
	onSelect,
	onClose,
}: LanguagePickerProps) {
	const [term, setTerm] = useState("");
	const [highlight, setHighlight] = useState(0);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const options = useMemo((): readonly (Language | typeof AUTO_ENTRY)[] => {
		const matches = searchLanguages(term);
		// Auto detection only makes sense on the source side, and only when the
		// search term does not exclude it.
		if (allowAuto && (term.trim() === "" || "检测语言".includes(term.trim()))) {
			return [AUTO_ENTRY, ...matches];
		}
		return matches;
	}, [term, allowAuto]);

	// Reset on open so a previous search does not leak into a new interaction.
	useEffect(() => {
		if (!open) return;
		setTerm("");
		const index = options.findIndex((option) => option.code === selected);
		setHighlight(index >= 0 ? index : 0);
	}, [open, selected, options]);

	// Focus the search box whenever the dialog opens.
	useEffect(() => {
		if (open) searchRef.current?.focus();
	}, [open]);

	// Keep the highlighted row in view as the user arrows through.
	useEffect(() => {
		if (!open) return;
		const node = listRef.current?.children[highlight] as
			| HTMLElement
			| undefined;
		node?.scrollIntoView({ block: "nearest" });
	}, [highlight, open]);

	// Typing anywhere in the dialog should reach the search field.
	useEffect(() => {
		if (!open) return;

		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
				return;
			}

			if (event.key === "ArrowDown") {
				event.preventDefault();
				setHighlight((current) => Math.min(current + 1, options.length - 1));
				return;
			}

			if (event.key === "ArrowUp") {
				event.preventDefault();
				setHighlight((current) => Math.max(current - 1, 0));
				return;
			}

			if (event.key === "Enter") {
				const option = options[highlight];
				if (option) {
					event.preventDefault();
					onSelect(option.code);
				}
				return;
			}

			// A printable character with focus outside the input moves focus in,
			// so the character is not lost.
			if (
				event.key.length === 1 &&
				!event.metaKey &&
				!event.ctrlKey &&
				!event.altKey &&
				document.activeElement !== searchRef.current
			) {
				searchRef.current?.focus();
			}
		}

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, options, highlight, onSelect, onClose]);

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/40 p-4 pt-16"
			role="dialog"
			aria-modal="true"
			aria-label="选择语言"
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			onKeyDown={(event) => {
				// Esc also closes at the window level; keeping it here makes the
				// click target's keyboard equivalent explicit.
				if (event.key === "Escape") onClose();
			}}
		>
			<div className="island-shell w-full max-w-md rounded-md p-4">
				<input
					ref={searchRef}
					id="language-search"
					name="language-search"
					aria-label="搜索语言"
					className="w-full rounded-md border border-input bg-background min-h-11 px-3 text-sm "
					placeholder="搜索语言（中文名、英文名或代码）"
					value={term}
					onChange={(event) => {
						setTerm(event.target.value);
						setHighlight(0);
					}}
				/>

				{options.length === 0 ? (
					<p className="mt-4 text-muted-foreground text-sm">
						没有匹配的语言。试试输入中文名、英文名或语言代码。
					</p>
				) : (
					<div
						ref={listRef}
						className="mt-3 max-h-72 overflow-y-auto"
						role="listbox"
						aria-label="语言列表"
					>
						{options.map((option, index) => {
							const isSelected = option.code === selected;
							const isHighlighted = index === highlight;
							return (
								<div key={option.code}>
									<button
										type="button"
										role="option"
										aria-selected={isSelected}
										className={
											isHighlighted
												? "flex w-full items-center justify-between rounded-md bg-surface px-3 py-2 text-left text-sm"
												: "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm"
										}
										onMouseEnter={() => setHighlight(index)}
										onClick={() => onSelect(option.code)}
									>
										<span>
											{option.nameZh}
											{option.code !== AUTO_DETECT && (
												<span className="ml-2 text-muted-foreground text-xs">
													{option.code}
												</span>
											)}
										</span>
										{isSelected && <span className="text-xs">已选</span>}
									</button>
								</div>
							);
						})}
					</div>
				)}

				<div className="mt-3 flex justify-between text-muted-foreground text-xs">
					<span>↑↓ 移动 · Enter 选中 · Esc 关闭</span>
					<button
						type="button"
						className="nav-link min-h-11 inline-flex items-center"
						onClick={onClose}
					>
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}

/** Label for a language chip, marking detected languages. */
export function languageChipLabel(code: string, detected: boolean): string {
	if (code === AUTO_DETECT) return "检测语言";
	const name = languageByCode(code)?.nameZh ?? code;
	return detected ? `${name} - 检测到的语言` : name;
}
