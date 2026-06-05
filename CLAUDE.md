# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome/Edge extension ("Bilingual Immersive Translator") that translates web pages in place. **Vanilla JS, no build step, no dependencies, no tests, no linter.** Nothing is transpiled or bundled — the repo root *is* the extension.

## Running / iterating

There is no CLI. To run it:

1. `chrome://extensions` (or `edge://extensions`) → enable Developer mode → "Load unpacked" → select this repo root.
2. After editing **`src/background.js`**, click the extension's reload icon on that page (service workers are not hot-reloaded).
3. After editing **`src/content.js` / `content.css`**, reload the *target web page* (and usually the extension too).
4. Popup/options HTML+JS reload when you reopen the popup / options page.

Debugging: background logs are under the service-worker "Inspect" link on `chrome://extensions`; content-script logs are in the page's own DevTools console; popup/options logs are in their respective DevTools.

## Architecture

Four execution contexts, each a separate JS realm, coordinated only by message passing and `chrome.storage`:

- **`src/defaults.js`** — the single source of truth for the settings schema. Loaded *first* into every context (background via `importScripts`, content scripts + popup + options via manifest/script tags). It assigns `BIT_DEFAULT_SETTINGS`, `BIT_SECRET_DEFAULTS`, `BIT_DEFAULT_SETTING_KEYS`, `BIT_SECRET_SETTING_KEYS` onto `globalThis`. Every other file reads its keys from these globals. **Add any new setting key here first.**

- **`src/background.js`** (service worker) — the **provider gateway**. It is the only context that reads API keys and makes translation network calls. Content scripts never see keys; they send a `TRANSLATE_BATCH` message and get translated strings back. Also owns: split-session state (persisted in `chrome.storage.session`), scroll-message relay between split tabs, the action context menu, and the secrets migration.

- **`src/content.js`** — all DOM work, injected into every page (also re-injectable on demand by the popup via `chrome.scripting`). Self-cleans on re-injection via `window.__bitTranslatorCleanup`. Guards heavily against "Extension context invalidated" errors (see `isContextInvalidatedError` / `disableRuntime`).

- **`popup.html`/`src/popup.js`** (action click → quick translate) and **`options.html`/`src/options.js`** (right-click action → "상세 설정 열기" → full settings, API keys, usage logs). Both drive translation by messaging the active tab's content script.

### Settings storage split (important)

- Non-secret settings → `chrome.storage.sync` (keys = `BIT_DEFAULT_SETTINGS`).
- **API keys → `chrome.storage.local` only** (keys = `BIT_SECRET_DEFAULTS`). Never synced, never passed to content scripts. `migrateSecretsToLocal` (in both `background.js` and `options.js`) moves any legacy keys out of `sync` and deletes them there.
- Content scripts read only the public `sync` settings and treat `enabled` as runtime-local (it is intentionally removed from sync).

### Message protocol

Content script **receives**: `TRANSLATE_PAGE`, `START_IN_PAGE_SPLIT`, `START_SPLIT_SOURCE`, `START_SPLIT_TARGET`, `APPLY_SPLIT_SCROLL`, `SCROLL_TO_BLOCK`, `CLEAR_TRANSLATIONS`, `GET_PAGE_STATUS`.
Background **receives** (`RUNTIME_MESSAGE_HANDLERS`): `TRANSLATE_BATCH`, `SPLIT_SCROLL`, `CLEAR_SPLIT_SESSION`.
All handlers answer `{ ok: true, ... }` / `{ ok: false, error }`; async handlers `return true` to keep the channel open.

### Translation rendering modes (in `content.js`)

1. **inline** (`translatePage`) — collects block elements (`BLOCK_SELECTOR`) + standalone text containers, batches them, and either inserts a `.bit-translation` node below each block or replaces it (`displayMode` = `below` | `replace`).
2. **in-page split** (`startInPageSplit` + the `mirror*` functions) — the *current* split implementation. Clones `document.body` into a two-pane `.bit-mirror-root` overlay, translates the right pane's visible text nodes in place, and keeps the panes scroll-synced. This is what the popup's "분할 보기" button triggers.
3. **two-tab split** (`startSplitSource`/`startSplitTarget`, `SPLIT_SCROLL`↔`APPLY_SPLIT_SCROLL` relayed through the background) — legacy scaffolding. The window-spawning entry point (`startSplitMode` in `background.js`) intentionally throws; the in-tab source/target handlers and scroll relay remain but are not wired to a UI button.

Viewport-scoped translation re-runs automatically on scroll/resize, deduped via "viewport signatures" so the same visible set isn't re-translated.

### Provider abstraction

`translateBatchWithProvider` (background) switches on `settings.provider`:
- `google`, `mymemory` — keyless REST endpoints, one request per text.
- `zhipu`, `gpt`, `openai` — funnel through `translateWithOpenAICompatible` via `getOpenAICompatibleSettings`, which maps the provider's own `*Endpoint`/`*ApiKey`/`*Model` keys onto generic `openai*` fields (config in `OPENAI_COMPATIBLE_PROVIDER_CONFIG`).
- `gemini`, `claude` — dedicated fetchers.

LLM providers are prompted to return a JSON array of translations (`buildTranslationPrompt` / the `TRANSLATION_JSON_*_INSTRUCTION` constants); `parseTranslations` → `parseJsonValue` tolerantly extracts the array (handles fenced code, object wrappers like `{translations:[...]}`, etc.) and **throws if the count doesn't match the input length**. Only the official `api.openai.com` host gets a strict `response_format` json_schema.

### Security model

Everything crossing a trust boundary is allowlisted in `background.js`: `ALLOWED_PROVIDERS`, `ALLOWED_LANGS`, `ALLOWED_MODELS`, and `sanitizeSettings`/`sanitizeOptions` (drop anything not explicitly permitted). `sanitizeError` redacts key-like substrings before logging/returning. OpenAI-compatible endpoints must be HTTPS, credential-free, and end in `/chat/completions` (`isAllowedOpenAICompatibleEndpoint`); non-`api.openai.com` hosts trigger a runtime host-permission request (`ensureEndpointPermission` in popup/options) backed by `optional_host_permissions`. Note: per-provider fixed endpoints (`gptEndpoint`, `zhipuEndpoint`, …) are deliberately *not* in the sanitize allowlist, so they always resolve to their `defaults.js` values and are not user-overridable.

## Adding a translation provider

A provider touches every layer; the existing `gpt`/`zhipu` entries are the template for an OpenAI-compatible one:

1. **`src/defaults.js`** — add `<id>Endpoint` + `<id>Model` to `DEFAULT_SETTINGS`, and `<id>ApiKey` to `SECRET_DEFAULTS`.
2. **`src/background.js`** — add the id to `ALLOWED_PROVIDERS`; add `<id>Model` set to `ALLOWED_MODELS`; for OpenAI-compatible providers add an entry to `OPENAI_COMPATIBLE_PROVIDER_CONFIG` and a `case` in `translateBatchWithProvider` (otherwise write a dedicated `translateWith…` fetcher); add to `PROVIDER_MODEL_KEYS`.
3. **`manifest.json`** — add the API host to `host_permissions`.
4. **`popup.html` + `options.html`** — add a `<option>` to the `#provider` select and a `.provider-field` (`data-provider-field="<id>"`) for the model; add an API-key `<input>` in the options "API 키" panel.
5. **`src/popup.js` + `src/options.js`** — query the new model element, set it in `fill*`, and include it in `read*Settings`; in `options.js` add the key input to `API_KEY_INPUTS`.

## Conventions

- User-facing strings are Korean; keep new UI copy and status messages Korean to match.
- `bit-` is the project prefix for injected CSS classes, dataset attributes (`data-bit-*`), DOM ids, and storage/message constants — keep it to avoid colliding with page styles.
- Settings/options validation is centralized in `background.js`; don't trust values arriving from content scripts or the popup without routing them through the existing sanitizers.
