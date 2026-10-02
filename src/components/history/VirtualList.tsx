/**
 * Fixed-height virtual list.
 *
 * The history list can hold up to 1000 records, so rendering them all would put
 * thousands of nodes in the DOM — the PRD caps this at 200 (design.md D8). Only
 * the visible window (plus a small overscan) is rendered.
 *
 * A fixed row height keeps this to a few dozen lines; a dynamic-height
 * implementation would need measurement and reflow logic that this list does not
 * require.
 *
 * Note the deliberate contrast with the language picker: twelve entries do not
 * justify virtualization, a thousand do.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Row height in pixels. Must match the CSS. */
export const ROW_HEIGHT = 88;

/** Extra rows rendered above and below the viewport to hide scroll latency. */
const OVERSCAN = 3;

/** Visible window description. */
export interface VirtualWindow {
	readonly startIndex: number;
	readonly endIndex: number;
	/** Total scrollable height. */
	readonly totalHeight: number;
	/** Offset of the first rendered row. */
	readonly offsetY: number;
}

/**
 * Compute which rows to render.
 *
 * Pure, so the arithmetic (including the boundaries) is testable without a DOM.
 */
export function computeWindow(options: {
	readonly itemCount: number;
	readonly scrollTop: number;
	readonly viewportHeight: number;
	readonly rowHeight?: number;
	readonly overscan?: number;
}): VirtualWindow {
	const rowHeight = options.rowHeight ?? ROW_HEIGHT;
	const overscan = options.overscan ?? OVERSCAN;
	const itemCount = Math.max(0, options.itemCount);

	if (itemCount === 0) {
		return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetY: 0 };
	}

	const firstVisible = Math.floor(Math.max(0, options.scrollTop) / rowHeight);
	const visibleCount = Math.max(
		1,
		Math.ceil(options.viewportHeight / rowHeight),
	);

	// Clamp so an overscan at the end cannot ask for rows that do not exist.
	const startIndex = Math.max(0, firstVisible - overscan);
	const endIndex = Math.min(itemCount, firstVisible + visibleCount + overscan);

	return {
		startIndex,
		endIndex,
		totalHeight: itemCount * rowHeight,
		offsetY: startIndex * rowHeight,
	};
}

/** Props for the virtual list. */
export interface VirtualListProps<T> {
	readonly items: readonly T[];
	readonly renderItem: (item: T, index: number) => React.ReactNode;
	readonly rowHeight?: number;
	/** Called when the user scrolls near the end, to load the next page. */
	readonly onEndReached?: () => void;
	readonly className?: string;
	readonly emptyState?: React.ReactNode;
}

/** A virtualized vertical list. */
export function VirtualList<T>({
	items,
	renderItem,
	rowHeight = ROW_HEIGHT,
	onEndReached,
	className,
	emptyState,
}: VirtualListProps<T>) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewportHeight, setViewportHeight] = useState(0);

	// Track the viewport height, since it determines how many rows fit.
	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		const measure = () => setViewportHeight(element.clientHeight);
		measure();

		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const window_ = useMemo(
		() =>
			computeWindow({
				itemCount: items.length,
				scrollTop,
				viewportHeight,
				rowHeight,
			}),
		[items.length, scrollTop, viewportHeight, rowHeight],
	);

	const handleScroll = useCallback(
		(event: React.UIEvent<HTMLDivElement>) => {
			const element = event.currentTarget;
			setScrollTop(element.scrollTop);

			if (!onEndReached || rowHeight <= 0) return;
			// Ask for the next page before reaching the very bottom, so loading is
			// not visible as a stall.
			const remaining =
				element.scrollHeight - element.scrollTop - element.clientHeight;
			if (remaining < rowHeight * 5) onEndReached();
		},
		[onEndReached, rowHeight],
	);

	if (items.length === 0) {
		return (
			<div ref={containerRef} className={className}>
				{emptyState}
			</div>
		);
	}

	const visible = items.slice(window_.startIndex, window_.endIndex);

	return (
		<div ref={containerRef} className={className} onScroll={handleScroll}>
			{/* The spacer establishes the full scroll height so the scrollbar is honest. */}
			<div style={{ height: window_.totalHeight, position: "relative" }}>
				<div style={{ transform: `translateY(${window_.offsetY}px)` }}>
					{visible.map((item, offset) => {
						const index = window_.startIndex + offset;
						return (
							<div key={index} style={{ height: rowHeight }}>
								{renderItem(item, index)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
