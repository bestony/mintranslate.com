/**
 * Event schema.
 *
 * One map from event name to its parameters. `track()` derives its signature from
 * this map, so a missing or misspelled parameter is a compile error rather than a
 * silently missing field in a report.
 *
 * Enum-typed parameters reference the existing constants (`ERROR_TYPES`,
 * `PROVIDER_IDS`) instead of restating their values. Those constants already match
 * the PRD's enumerations; a second copy would drift.
 *
 * The schema is the single source of truth. `docs/analytics-events.md` is the
 * human-readable inventory maintained alongside it, and a test asserts the two
 * list the same event names.
 */

import type { ErrorType } from "../connections/attribution";
import type { ProviderId } from "../connections/model";

/** Input kinds, matching the PRD's `input_kind` values. */
export const INPUT_KINDS = ["text", "image", "document", "website"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** Modes, from the workspace URL parameter. */
export const ANALYTICS_MODES = ["text", "images", "docs", "websites"] as const;
export type AnalyticsMode = (typeof ANALYTICS_MODES)[number];

/** Which side of the language pair changed. */
export const LANGUAGE_SIDES = ["source", "target"] as const;
export type LanguageSide = (typeof LANGUAGE_SIDES)[number];

/** What caused a language change. */
export const LANGUAGE_TRIGGERS = [
	"chip",
	"search_list",
	"swap",
	"url",
] as const;
export type LanguageTrigger = (typeof LANGUAGE_TRIGGERS)[number];

/** Parameters common to every event. */
export interface CommonParams {
	readonly app_version: string;
	readonly ui_lang: string;
	readonly is_byok_configured: boolean;
}

/**
 * The event map.
 *
 * Every value is the set of event-specific parameters. Parameters are `snake_case`
 * and every one is justified by a question in the PRD's analytics goals — this is
 * not a place to record things because they are available.
 */
export interface AnalyticsEventMap {
	app_open: {
		readonly entry_mode: AnalyticsMode;
		/** Whether the URL carried source text. The text itself is never sent. */
		readonly has_url_text: boolean;
	};
	translate_submit: {
		readonly mode: AnalyticsMode;
		readonly source_lang: string;
		readonly target_lang: string;
		/** Character count, never content. */
		readonly input_chars: number;
		readonly input_kind: InputKind;
	};
	translate_success: {
		readonly mode: AnalyticsMode;
		readonly source_lang: string;
		readonly target_lang: string;
		readonly provider: ProviderId;
		readonly model: string;
		readonly latency_ms: number;
		readonly is_streaming: boolean;
	};
	translate_error: {
		readonly mode: AnalyticsMode;
		readonly provider: ProviderId;
		readonly model: string;
		readonly error_type: ErrorType;
		readonly http_status?: number;
	};
	lang_change: {
		readonly side: LanguageSide;
		readonly from_lang: string;
		readonly to_lang: string;
		readonly is_auto_detect: boolean;
		readonly trigger: LanguageTrigger;
	};
	provider_config_save: {
		readonly provider: ProviderId;
		readonly is_custom_endpoint: boolean;
		readonly has_base_url_override: boolean;
	};
	connection_test: {
		readonly provider: ProviderId;
		readonly success: boolean;
		readonly error_type: ErrorType;
		readonly latency_ms: number;
	};
	cors_blocked: {
		readonly provider: ProviderId;
		/**
		 * Hostname only — no protocol, no path. For a custom endpoint this is the
		 * hashed value, never the user's private domain.
		 */
		readonly endpoint_host: string;
	};
	model_in_use: {
		readonly provider: ProviderId;
		readonly model: string;
	};
}

/** Every event name, derived from the map so it cannot fall out of step. */
export type AnalyticsEventName = keyof AnalyticsEventMap;

/** The event names as a runtime list, for the inventory test and iteration. */
export const ANALYTICS_EVENT_NAMES = [
	"app_open",
	"translate_submit",
	"translate_success",
	"translate_error",
	"lang_change",
	"provider_config_save",
	"connection_test",
	"cors_blocked",
	"model_in_use",
] as const satisfies readonly AnalyticsEventName[];

/** Maximum length for a free-form string parameter such as a model id. */
export const MAX_FREE_TEXT_LENGTH = 64;

/**
 * Whether a free-form value is safe to send.
 *
 * Control characters are rejected outright, and the length cap keeps a
 * pasted document from becoming a report field. Over-long values are truncated;
 * values with unusual characters are dropped, per the spec.
 */
export function isSendableFreeText(value: string): boolean {
	// Letters, digits, and the punctuation real model ids use (`.`, `-`, `_`, `/`,
	// `:`, `@`, `+`). Anything else is more likely to be pasted content than a name.
	return /^[A-Za-z0-9._:/@+-]*$/.test(value);
}

/** Truncate a free-form value to the schema's limit. */
export function clampFreeText(value: string): string {
	return value.length <= MAX_FREE_TEXT_LENGTH
		? value
		: value.slice(0, MAX_FREE_TEXT_LENGTH);
}

/** Keys that must never appear in a payload, regardless of what a caller passes. */
export const FORBIDDEN_KEYS = [
	"apikey",
	"api_key",
	"authorization",
	"key",
	"token",
	"secret",
	"password",
	"text",
	"sourcetext",
	"source_text",
	"targettext",
	"target_text",
	"suggestion",
	"prompt",
	"systeminstruction",
	"system_instruction",
	"terms",
	"glossary",
	"endpoint",
	"baseurl",
	"base_url",
] as const;

/** Whether a key is forbidden outright. */
export function isForbiddenKey(key: string): boolean {
	const lowered = key.toLowerCase();
	return FORBIDDEN_KEYS.some((forbidden) => lowered === forbidden);
}
