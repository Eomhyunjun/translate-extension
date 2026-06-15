# Bilingual Immersive Translator

[한국어](README.md) | **English**

A Manifest V3 Chrome/Edge extension for translating web pages in place. It can render translated text under each original paragraph, replace the original text, or open a same-tab split view with the original page on the left and translated text on the right.

The extension is intentionally simple: vanilla JavaScript, no build step, no bundler, and no runtime dependencies.

## Features

- Inline bilingual translation for readable page blocks
- Same-tab split translation view with scroll sync
- Popup controls for provider, model, source language, and target language
- Options page for full settings, API keys, usage logs, and pasted-text translation
- Per-paragraph retry when a translation fails
- Batch fallback for model responses that return malformed or mismatched output
- URL, domain, and email-like standalone text skipping
- Inline sentence grouping for text split across sibling tags
- Local-only API key storage via `chrome.storage.local`
- Optional local usage logs with request previews and token estimates

## Supported Providers

- Google Translate web endpoint, no key required
- MyMemory, no key required
- Microsoft Translator
- Zhipu BigModel
- GPT / OpenAI
- Gemini
- Claude
- Upstage Solar
- Generic OpenAI-compatible chat completions endpoint

Keyed providers require their own API keys. The extension never sends API keys to content scripts; provider calls are made from the background service worker.

## Install Locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this repository directory.
5. Pin or open the extension from the browser toolbar.
6. Configure provider settings from the popup or the options page.

When editing the extension:

- Reload the extension after changing `src/background.js`, `manifest.json`, or HTML files.
- Reload the target web page after changing `src/content.js` or `src/content.css`.
- Reopen the popup/options page after changing popup/options files.

## Usage

Open the popup and choose one of the translation modes:

- `Inline view`: translates visible/page blocks in place.
- `Split view`: opens a two-pane reader inside the current tab.
- `Clear translations`: removes injected translation UI and closes split view.

Keyboard shortcuts are defined in `manifest.json`:

- Inline translation: `Cmd+Shift+1` on macOS, `Alt+Shift+1` elsewhere
- Split translation: `Cmd+Shift+2` on macOS, `Alt+Shift+2` elsewhere

The options page also includes a pasted-text translation tab. It uses the same provider and language settings as page translation.

## Provider Setup

The default Google provider requires no key and is useful for quick local testing. For better quality and reliability, choose a keyed provider in the options page.

- Microsoft: set your Azure Translator key and region.
- Zhipu: set your Zhipu API key and model.
- GPT / OpenAI: set your OpenAI API key and model.
- Gemini: set your Google AI Studio API key and model.
- Claude: set your Anthropic API key and model.
- Upstage Solar: set your Upstage API key and model.
- OpenAI-compatible: set a provider API key, model, and HTTPS endpoint ending in `/chat/completions`.

OpenAI-compatible endpoints cannot include embedded credentials. Non-OpenAI hosts request optional host permission when saved.

## Privacy

API keys are stored only in `chrome.storage.local`. They are not synced through `chrome.storage.sync` and are not exposed to page content scripts.

Usage logging is disabled by default. When enabled, the extension stores up to 100 local request batch logs in `chrome.storage.local`, including input/output previews, status, duration, and token counts or estimates.

Browser extensions cannot make user-provided API keys impossible to inspect on the user's own device. Use revocable, quota-limited keys for this extension.

## Project Structure

```text
manifest.json        Extension manifest
popup.html           Browser action popup
options.html         Full settings page
src/defaults.js      Shared default settings schema
src/background.js    Provider gateway and service worker
src/content.js       Page DOM collection, rendering, split view, retry handling
src/content.css      Injected page styles
src/popup.js         Popup controller
src/options.js       Options page controller
assets/              Extension icons and logo
```

## Development

There is no build command. The repository root is the unpacked extension.

Useful checks:

```bash
node --check src/background.js
node --check src/content.js
node --check src/options.js
node --check src/popup.js
git diff --check
```

## Status

This is a local extension prototype, not a Chrome Web Store-ready package. Before distribution, review provider quotas, content security policy, privacy copy, error handling, and browser-store requirements.
