/**
 * Secondary search button.
 *
 * Takes the translation to a search engine. The query carries only the
 * translation — a search URL lands in history and possibly provider logs, so
 * nothing about the connection or the user travels with it.
 */

import { useState } from "react";
import { logger } from "#/lib/logger";
import {
	DEFAULT_SEARCH_ENGINE,
	SEARCH_ENGINES,
	searchText,
} from "#/lib/search-lookup";

interface SearchLookupButtonProps {
	readonly targetText: string;
	/** Injected for tests; defaults to `window.open`. */
	readonly openInNewTab?: (
		url: string,
		target: string,
		features: string,
	) => unknown;
}

export function SearchLookupButton({
	targetText,
	openInNewTab,
}: SearchLookupButtonProps) {
	const [engine, setEngine] = useState(DEFAULT_SEARCH_ENGINE);
	const [showEngines, setShowEngines] = useState(false);

	const disabled = targetText.trim() === "";

	function run() {
		const open =
			openInNewTab ??
			((url: string, target: string, features: string) => {
				if (typeof window !== "undefined") window.open(url, target, features);
			});

		const opened = searchText(targetText, engine, open);
		if (!opened) return;

		logger.info("search.opened", { engine });
	}

	function choose(id: typeof engine) {
		setEngine(id);
		setShowEngines(false);
	}

	return (
		<div className="flex flex-wrap items-center gap-3">
			<button
				type="button"
				className="nav-link min-h-11 inline-flex items-center text-xs disabled:opacity-40"
				disabled={disabled}
				title={disabled ? "没有可检索的译文" : undefined}
				onClick={run}
			>
				使用搜索引擎
			</button>

			<button
				type="button"
				className="nav-link min-h-11 inline-flex items-center text-xs disabled:opacity-40"
				disabled={disabled}
				aria-expanded={showEngines}
				onClick={() => setShowEngines((current) => !current)}
			>
				{SEARCH_ENGINES.find((entry) => entry.id === engine)?.label ?? engine}
			</button>

			{showEngines && (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface min-h-11 px-2">
					{SEARCH_ENGINES.map((entry) => (
						<button
							key={entry.id}
							type="button"
							className={
								engine === entry.id
									? "min-h-11 rounded-sm border border-primary bg-primary/10 px-2 text-xs"
									: "min-h-11 rounded-sm border border-border px-2 text-xs"
							}
							aria-pressed={engine === entry.id}
							onClick={() => choose(entry.id)}
						>
							{entry.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
