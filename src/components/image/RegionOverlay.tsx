/**
 * Region overlay.
 *
 * Regions are absolutely positioned DOM elements rather than shapes drawn on a
 * canvas. That choice is what makes the accessibility requirements reachable:
 * a drawn box cannot be focused, enumerated by a screen reader, or driven from the
 * keyboard, so a canvas implementation would need a parallel hotspot layer — which
 * is a DOM overlay with extra steps.
 *
 * Positions are percentages, so the overlay tracks the image at any display size
 * without measuring anything. The model returns normalized coordinates for the same
 * reason (design D4).
 *
 * Visibility on any backdrop: each region carries a two-tone edge — a strong border
 * against light content and a contrasting outline against dark content. The design
 * system forbids shadows, so this is borders only.
 */

import type { ImageRegion, NormalizedBox } from "#/lib/image";

interface RegionOverlayProps {
	readonly regions: readonly ImageRegion[];
	/** Region currently linked from the list, highlighted. */
	readonly activeId?: string;
	/** Receives focus and pointer, so both directions of the link work. */
	readonly onActivate: (id: string) => void;
	/** Alt text for the underlying image. */
	readonly imageAlt: string;
	/** Rendered source; the processed image, which is what the model saw. */
	readonly imageSrc: string;
	/** Natural width, so the image is never upscaled for display. */
	readonly naturalWidth?: number;
}

/** Percentage style for a normalized box. */
function boxStyle(box: NormalizedBox): Record<string, string> {
	return {
		left: `${box.x * 100}%`,
		top: `${box.y * 100}%`,
		width: `${box.width * 100}%`,
		height: `${box.height * 100}%`,
	};
}

export function RegionOverlay({
	regions,
	activeId,
	onActivate,
	imageAlt,
	imageSrc,
	naturalWidth,
}: RegionOverlayProps) {
	const locatable = regions.filter(
		(region): region is ImageRegion & { box: NormalizedBox } =>
			region.box !== undefined,
	);

	return (
		<div className="relative inline-block max-w-full">
			<img
				src={imageSrc}
				alt={imageAlt}
				style={
					naturalWidth === undefined
						? undefined
						: { maxWidth: `min(100%, ${naturalWidth}px)` }
				}
				className="max-h-[60vh] rounded-md border border-border"
			/>

			{/* Pointer events off on the layer, on for each region: otherwise the layer
			    would swallow clicks meant for the image. */}
			<div className="pointer-events-none absolute inset-0">
				{locatable.map((region) => {
					const active = region.id === activeId;
					return (
						<button
							key={region.id}
							type="button"
							// The label is the region's text, so a screen reader announces
							// what is under the box rather than "button".
							aria-label={`区域：${region.source || region.target}${
								region.uncertain ? "（识别不确定）" : ""
							}`}
							data-region-id={region.id}
							data-uncertain={region.uncertain ? "true" : "false"}
							className={[
								"pointer-events-auto absolute rounded-sm",
								// Two-tone edge: the border reads on light content, the outline
								// on dark content, so a region is never invisible.
								"border-2 outline outline-1",
								region.uncertain
									? "border-dashed border-primary-strong outline-background"
									: "border-primary-strong outline-background",
								active ? "bg-primary/20" : "bg-transparent",
							].join(" ")}
							style={boxStyle(region.box)}
							onFocus={() => onActivate(region.id)}
							onMouseEnter={() => onActivate(region.id)}
							onClick={() => onActivate(region.id)}
						/>
					);
				})}
			</div>
		</div>
	);
}
