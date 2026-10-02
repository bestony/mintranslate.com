# Analytics Events

MinTranslate sends anonymous product-usage events to Google Analytics 4 (GA4).

The event schema in `src/lib/analytics/events.ts` is the **single source of truth**.
This document is the human-readable inventory that must match it; a unit test fails
if the two disagree. Use this list when registering custom events and dimensions in
the GA4 property.

## What is never sent

- Source text, translated text, image, document, or fetched page content
- API keys, tokens, or any fragment, hash, or length of one
- Full endpoint URLs (hostname only; custom endpoints are hashed)
- Custom system prompts, style instructions, or glossary contents
- History or feedback contents

## Common parameters

Every event carries these:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `app_version` | string | Application version, to separate releases |
| `ui_lang` | string | Interface language |
| `is_byok_configured` | boolean | Whether any connection has been configured (never which one) |

## Events

### `app_open`

Sent once per browser session when the app becomes ready.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `entry_mode` | `text` \| `images` \| `docs` \| `websites` | Mode the app opened in |
| `has_url_text` | boolean | Whether the URL carried source text (the text itself is never sent) |

Purpose: measure whether the app is actually being used, and from which mode.

### `translate_submit`

Sent when a translation request starts. Throttled, because typing produces many.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `mode` | mode | Translation mode |
| `source_lang` | string | Source language code |
| `target_lang` | string | Target language code |
| `input_chars` | number | Input length in characters (never content) |
| `input_kind` | `text` \| `image` \| `document` \| `website` | What was submitted |

Purpose: translation volume and the funnel's first step.

### `translate_success`

Sent when a complete result arrives. Not throttled: these counts are the analysis.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `mode` | mode | Translation mode |
| `source_lang` | string | Source language code |
| `target_lang` | string | Target language code |
| `provider` | provider | Provider identifier |
| `model` | string | Model id, truncated to 64 characters |
| `latency_ms` | number | Request duration, measured from the request start |
| `is_streaming` | boolean | Whether the response streamed |

Purpose: success rate and latency.

### `translate_error`

Sent when a request fails.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `mode` | mode | Translation mode |
| `provider` | provider | Provider identifier |
| `model` | string | Model id |
| `error_type` | error type | Fixed failure cause |
| `http_status` | number | Present only when a response carried one |

Purpose: where users get stuck.

### `lang_change`

Sent when either side of the language pair changes.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `side` | `source` \| `target` | Which side changed |
| `from_lang` | string | Previous language code |
| `to_lang` | string | New language code |
| `is_auto_detect` | boolean | Whether the source was left on auto-detect |
| `trigger` | `chip` \| `search_list` \| `swap` \| `url` | What caused the change |

Purpose: language-pair preferences.

### `provider_config_save`

Sent when a connection configuration is saved.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `provider` | provider | Provider identifier |
| `is_custom_endpoint` | boolean | Whether the endpoint is user-supplied |
| `has_base_url_override` | boolean | Whether the endpoint differs from the preset |

Purpose: whether users can configure a provider at all.

### `connection_test`

Sent when a connection test finishes.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `provider` | provider | Provider identifier |
| `success` | boolean | Whether the test passed |
| `error_type` | error type | Failure cause when unsuccessful |
| `latency_ms` | number | Test duration |

Purpose: which step of configuration blocks users.

### `cors_blocked`

Sent when a request fails at the cross-origin or network layer. Sent alongside
`translate_error` or `connection_test` so the two can be cross-checked.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `provider` | provider | Provider identifier |
| `endpoint_host` | string | Hostname only; hashed for custom endpoints |

Purpose: which providers are unreachable from the browser.

Note on interpretation: a browser does not expose *why* a cross-origin request was
blocked, so this event is reliable at the **provider** level and **not** at the
cause level. Do not read it as evidence of a specific misconfiguration. Failures
inherent to a front-end-only app (for example fetching a third-party page) are
deliberately excluded so they do not skew provider compatibility.

### `model_in_use`

Sent each time a translation actually uses a model.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `provider` | provider | Provider identifier |
| `model` | string | Model id, truncated to 64 characters |

Purpose: which model/provider combinations are actually used, to order presets.

## Enumerations

**Provider** (`provider`): `openai`, `anthropic`, `gemini`, `deepseek`, `openrouter`, `ollama`, `custom`

**Error type** (`error_type`): `cors_or_network`, `dns`, `timeout`, `auth_401`, `forbidden_403`, `not_found_404`, `rate_limit_429`, `server_5xx`, `bad_response`, `aborted`, `unknown`

**Mode** (`mode`, `entry_mode`): `text`, `images`, `docs`, `websites`

**Input kind** (`input_kind`): `text`, `image`, `document`, `website`

## Opting out

The statistics toggle in settings is on by default. Turning it off stops all
sending immediately, clears the provider's cookies, and prevents the script from
being injected on the next load. Turning it back on takes effect without a reload.
