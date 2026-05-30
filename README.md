# Bilingual Immersive Translator

Immersive Translate style browser extension prototype. It translates readable page blocks inline, and can also open a translated split view that keeps the original page layout while replacing visible text in the translated window.

## Features

- Chrome/Edge Manifest V3 extension
- Paragraph-level bilingual translation
- Split translation mode: opens the same URL in a paired window and translates that copy in-place
- Scroll synchronization between the original and translated split windows
- Popup controls for provider, model, language, display mode, skip behavior, and paragraph batch size
- Clear translated text from the current page
- Google Translate provider by default
- Microsoft Translator, Zhipu BigModel, GPT/OpenAI, Gemini, Claude, MyMemory, and OpenAI-compatible providers
- API keys stored in `chrome.storage.local`, not synced across browser profiles

## Install locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Click "Load unpacked".
4. Select this project directory.
5. Open any article page and click the extension icon.

## Provider setup

The default Google provider uses a public web endpoint and requires no key, but it is best treated as a prototype/testing path. It defaults to English source text; change the source language in options when translating other languages.

Microsoft Translator, Zhipu BigModel, GPT/OpenAI, Gemini, and Claude may have free quotas or free-tier credits depending on the provider, but they still require provider accounts and API keys.

- Microsoft: choose `Microsoft Translator`, then set your Azure Translator key and region.
- Zhipu: choose `Zhipu BigModel`, then set your Zhipu API key and model, such as `glm-4-flash`.
- GPT/OpenAI: choose `GPT / OpenAI`, then set your OpenAI API key and model.
- Gemini: choose `Gemini`, then set your Google AI Studio API key and model.
- Claude: choose `Claude`, then set your Anthropic API key and model.
- MyMemory: choose `MyMemory 무료 API`; no key is required, but public limits are low.

## API key privacy

User API keys are stored only in `chrome.storage.local`. They are not stored in `chrome.storage.sync`, are not sent to content scripts, and are used only by the background service worker when calling the selected translation provider.

Browser extensions cannot make user-provided API keys impossible to inspect on the user's own device. For distribution, tell users to create revocable, quota-limited keys for this extension.

For better quality, choose a provider and model from the extension popup. Add API keys from the options page.

- Endpoint: `https://api.openai.com/v1/chat/completions`
- API key: your API key
- Model: for example `gpt-4o-mini`

Any provider that supports OpenAI-compatible chat completions should work if it returns normal `choices[0].message.content`.

## Notes

This is a local prototype, not a store-ready clone. Production work should add caching, quota handling, streaming progress UI, PDF/EPUB support, subtitle support, and a privacy review before distribution.
