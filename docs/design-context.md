---
version: alpha
name: OpenAI
description: "A light interface extracted from OpenAI accented with #8e8ea0, with a 8px spacing system and a system-ui type stack."
sourceUrl: "https://openai.com"

colors:
  primary: "#8e8ea0"
  on-primary: "#ffffff"
  text: "#8e8ea0"
  text-muted: "#000000"

typography:
  display:
    fontFamily: "system-ui, sans-serif"
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.5
  heading:
    fontFamily: "system-ui, sans-serif"
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5

spacing:
  base: 8px
  scale: [8]

radius:
  sm: 5px

motion:
  duration-fast: 400ms
  duration-base: 400ms
  duration-slow: 400ms
  easing: "ease"

breakpoints: [768px]
---

# MinTranslate design context

This file is the single source of truth for the visual design of MinTranslate.
All UI must use these tokens.

## Summary

- Light mode. Flat surfaces. No shadows, no gradients.
- Palette: primary `#8e8ea0` (muted purple-gray), on-primary `#ffffff`, black `#000000`, white surfaces. No secondary or accent hues. Show status (success, error, warning) through value or opacity changes inside this palette, plus a text label or icon. Do not use color alone.
- Typography: `system-ui, sans-serif` for all text. Display 48/700, heading 32/600, body 16/400. Line height 1.5 for all levels. Use the platform monospace font for code.
- Spacing: 8px grid. All spacing values are multiples of 8px.
- Radius: 5px for all rounded elements.
- Motion: 400ms, `ease`, for all transitions. No spring or bounce. Respect `prefers-reduced-motion`.
- Breakpoint: 768px. Below it, stack columns.

## Components

- Buttons: primary background `#8e8ea0`, white text, 5px radius, no shadow. Minimum touch target 44x44px.
- Inputs: 5px radius, 1px border derived from the palette, no shadow.
- Cards and containers: separate by spacing, a 1px border, or a background change. No shadow.
- Focus: 2px outline with 2px offset, in black or primary. Always visible on keyboard focus.

## Accessibility override

The source sets body text to `#8e8ea0`. On white, this is about 3.5:1 and fails WCAG AA (4.5:1).
MinTranslate overrides this rule:

- Body text, translation input and output, and all critical information: `#000000` (or a dark neutral that gives at least 4.5:1).
- `#8e8ea0` is only for primary affordances (button backgrounds, active indicators) and large or decorative text that is not essential.
- Secondary text that must stay readable must have at least 4.5:1 contrast.
- **Primary button fill uses `primary-strong` `#6e6e80`, not `#8e8ea0`.** White on `#8e8ea0` measures 3.22:1 and fails AA for normal text; white on `#6e6e80` measures 4.99:1 and passes. `#8e8ea0` therefore stays the decorative primary (selected states, borders, indicators) while the darker token carries primary actions. This keeps the intended "white text on the primary colour" look without an accessibility failure.

## Rationale (from source)

The source describes "calculated simplicity": a restrained palette, native system fonts for performance and legibility, a strict 8px grid, uniform 400ms motion, and flat surfaces with one modest radius. The interface is a calm workspace for sustained use, not a consumer showcase.
