# Bilingual Immersive Translator

Immersive Translate style browser extension prototype. It translates readable page blocks inline, and can also open an in-page split view that mirrors the current HTML and replaces visible text on the translated side.

## Features

- Chrome/Edge Manifest V3 extension
- Paragraph-level bilingual translation
- Split translation mode: mirrors the current page inside the same tab with a 1:1 grid
- Scroll synchronization between the original and translated panes
- Extension icon click opens a compact popup for provider/model/language selection
- Right-click extension settings for provider, model, language, display mode, skip behavior, and paragraph batch size
- Popup buttons start inline translation or same-tab split translation immediately
- Popup translation removal clears translated text and closes split view
- Google Translate provider by default
- Microsoft Translator, Zhipu BigModel, GPT/OpenAI, Gemini, Claude, Upstage Solar, MyMemory, and OpenAI-compatible providers
- API keys stored in `chrome.storage.local`, not synced across browser profiles
- Optional usage logs stored locally, disabled by default

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click "Load unpacked".
4. Select this project directory.
5. Open any article page and click the extension icon to translate. Click again to remove translations.
6. Right-click the extension icon and choose settings to configure providers, models, API keys, and logs.

## Provider setup

The default Google provider uses a public web endpoint and requires no key, but it is best treated as a prototype/testing path. It defaults to English source text; change the source language in the settings page when translating other languages.

Microsoft Translator, Zhipu BigModel, GPT/OpenAI, Gemini, Claude, and Upstage Solar may have free quotas or free-tier credits depending on the provider, but they still require provider accounts and API keys.

- Microsoft: choose `Microsoft Translator`, then set your Azure Translator key and region.
- Zhipu: choose `Zhipu BigModel`, then set your Zhipu API key and model, such as `glm-4-flash`.
- GPT/OpenAI: choose `GPT / OpenAI`, then set your OpenAI API key and model.
- Gemini: choose `Gemini`, then set your Google AI Studio API key and model.
- Claude: choose `Claude`, then set your Anthropic API key and model.
- Upstage Solar: choose `Upstage Solar`, then set your Upstage API key and model, such as `solar-pro3`. The OpenAI-compatible endpoint is fixed to `https://api.upstage.ai/v1/solar/chat/completions`.
- MyMemory: choose `MyMemory 무료 API`; no key is required, but public limits are low.
- OpenAI-compatible: choose `OpenAI-compatible`, then set the provider API key, model, and an HTTPS endpoint ending in `/chat/completions`.

## API key privacy

User API keys are stored only in `chrome.storage.local`. They are not stored in `chrome.storage.sync`, are not sent to content scripts, and are used only by the background service worker when calling the selected translation provider.

Browser extensions cannot make user-provided API keys impossible to inspect on the user's own device. For distribution, tell users to create revocable, quota-limited keys for this extension.

For better quality, choose a provider and model from the extension settings page. Add API keys from the same page.

## OpenAI-compatible endpoints

Any provider that supports OpenAI-compatible chat completions should work if it returns normal `choices[0].message.content`. The endpoint must be an HTTPS URL without embedded credentials, and the path must end with `/chat/completions`. Non-OpenAI hosts request optional host permission when you save them.

Defaults:

- Endpoint: `https://api.openai.com/v1/chat/completions`
- Model: `gpt-4o-mini`

## Usage logs

Usage logging is off by default. When enabled in the options page, the extension stores up to 100 request batches in `chrome.storage.local`, including input/output text previews, status, duration, and actual or estimated token counts.

## Notes

This is a local prototype, not a store-ready clone. Production work should add caching, quota handling, streaming progress UI, PDF/EPUB support, subtitle support, and a privacy review before distribution.
