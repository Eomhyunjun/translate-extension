importScripts("defaults.js", "shared.js");

const DEFAULT_SETTINGS = globalThis.BIT_DEFAULT_SETTINGS;
const SECRET_DEFAULTS = globalThis.BIT_SECRET_DEFAULTS;

let logWriteQueue = Promise.resolve();
const ACTION_CONTEXT_MENU_SETTINGS_ID = "bit-open-settings";
const SPLIT_REOPEN_STORAGE_KEY = "splitReopen";
const COMMAND_VIEW_MODES = Object.freeze({
  "toggle-inline-translation": "inline",
  "toggle-split-translation": "split"
});
let secretsMigrationReady = null;

const MESSAGE_TYPES = {
  TRANSLATE_BATCH: "TRANSLATE_BATCH",
  SET_SPLIT_REOPEN: "SET_SPLIT_REOPEN",
  GET_SPLIT_REOPEN: "GET_SPLIT_REOPEN"
};

const RUNTIME_MESSAGE_HANDLERS = {
  [MESSAGE_TYPES.TRANSLATE_BATCH]: handleTranslateBatchMessage,
  [MESSAGE_TYPES.SET_SPLIT_REOPEN]: handleSetSplitReopenMessage,
  [MESSAGE_TYPES.GET_SPLIT_REOPEN]: handleGetSplitReopenMessage
};

const ALLOWED_PROVIDERS = new Set(["google", "microsoft", "zhipu", "gpt", "gemini", "claude", "solar", "openai", "mymemory"]);
const ALLOWED_LANGS = new Set(["auto", "ko", "en", "ja", "zh-CN", "zh-TW", "es", "fr", "de"]);
const ALLOWED_MODELS = {
  zhipuModel: new Set(["glm-4-flash", "glm-4-air", "glm-4-plus"]),
  gptModel: new Set(["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"]),
  geminiModel: new Set(["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"]),
  claudeModel: new Set(["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest"]),
  solarModel: new Set(["solar-pro3", "solar-pro2", "solar-mini"])
};
const ALLOWED_SPLIT_VIEW_MODES = new Set(["inline", "split"]);
const ALLOWED_SPLIT_DISPLAY_MODES = new Set(["below", "replace"]);
const ALLOWED_SPLIT_SCOPES = new Set(["viewport", "page"]);

const OPENAI_COMPATIBLE_PROVIDER_CONFIG = {
  zhipu: {
    endpointKey: "zhipuEndpoint",
    apiKeyKey: "zhipuApiKey",
    modelKey: "zhipuModel",
    providerLabel: "Zhipu BigModel"
  },
  gpt: {
    endpointKey: "gptEndpoint",
    apiKeyKey: "gptApiKey",
    modelKey: "gptModel",
    providerLabel: "GPT / OpenAI"
  },
  solar: {
    endpointKey: "solarEndpoint",
    apiKeyKey: "solarApiKey",
    modelKey: "solarModel",
    providerLabel: "Upstage Solar"
  },
  openai: {
    providerLabel: "OpenAI-compatible"
  }
};

const PROVIDER_MODEL_KEYS = {
  zhipu: "zhipuModel",
  gpt: "gptModel",
  gemini: "geminiModel",
  claude: "claudeModel",
  solar: "solarModel",
  openai: "openaiModel"
};

const PROVIDER_MODEL_LABELS = {
  microsoft: "Microsoft Translator",
  google: "Google Translate",
  mymemory: "MyMemory"
};

const TRANSLATION_UNIT_INSTRUCTION =
  "Translate each input string as one complete unit, faithfully and naturally.";
const TRANSLATION_PRESERVE_INSTRUCTION =
  "Preserve meaning, names, numbers, punctuation, inline whitespace, URLs, and email addresses.";
const TRANSLATION_ARRAY_ITEM_INSTRUCTION =
  "Do not merge, split, omit, reorder, or add array items.";
const TRANSLATION_JSON_ARRAY_INSTRUCTION = buildTranslationInstruction(
  "Return only a JSON array of translated strings with the same length and order as the input."
);
const TRANSLATION_JSON_OBJECT_INSTRUCTION = buildTranslationInstruction(
  "Return only JSON with this shape: {\"translations\":[\"...\"]}. The translations array must have the same length and order as the input texts."
);
const CLAUDE_SYSTEM_INSTRUCTION = buildTranslationInstruction(
  "Return only a JSON array of translated strings."
);
const TRANSLATION_ARRAY_RESPONSE_KEYS = Object.freeze([
  "translations",
  "translated",
  "translatedTexts",
  "translated_texts",
  "results",
  "result",
  "items"
]);
const TRANSLATION_ITEM_RESPONSE_KEYS = Object.freeze([
  "translation",
  "translatedText",
  "translated_text",
  "text",
  "output"
]);
const MAX_TRANSLATION_BATCH_SIZE = 50;
const MAX_TRANSLATION_TEXT_LENGTH = 3000;
// Some OpenAI-compatible providers (e.g. Upstage Solar) default to a tiny
// max_tokens when the caller omits one, truncating the JSON mid-string and making
// the response unparseable. Pin it to a large ceiling so output is never cut off;
// providers clamp this down to their own model limit when it is smaller.
const OPENAI_COMPATIBLE_MAX_TOKENS = 16384;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
  await chrome.storage.sync.remove("enabled");
  await migrateSecretsToLocal();
  await setupActionContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  migrateSecretsToLocal();
  setupActionContextMenu().catch(() => {});
});

setupActionContextMenu().catch(() => {});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === ACTION_CONTEXT_MENU_SETTINGS_ID) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener(routeRuntimeMessage);

chrome.commands.onCommand.addListener((command) => {
  handleCommand(command).catch((error) => {
    console.warn("Shortcut command failed", sanitizeError(error));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSplitReopenForTab(tabId).catch(() => {});
});

function routeRuntimeMessage(message, sender, sendResponse) {
  const handler = RUNTIME_MESSAGE_HANDLERS[message?.type];
  if (!handler) return false;

  try {
    respondToRuntimeMessage(handler(message, sender), sendResponse);
  } catch (error) {
    sendResponse({ ok: false, error: sanitizeError(error) });
  }
  return true;
}

function respondToRuntimeMessage(resultPromise, sendResponse) {
  Promise.resolve(resultPromise)
    .then((result) => {
      const payload = isPlainObject(result) ? result : {};
      sendResponse({ ok: true, ...payload });
    })
    .catch((error) => sendResponse({ ok: false, error: sanitizeError(error) }));
}

async function handleTranslateBatchMessage(message) {
  const translations = await translateBatch(normalizeTexts(message.texts), sanitizeOptions(message.options));
  return { translations };
}

async function handleSetSplitReopenMessage(message, sender) {
  const tabId = normalizeTabId(sender?.tab?.id);
  if (!Number.isInteger(tabId)) return { stored: false };

  const map = await getSplitReopenMap();
  if (message.reopen) {
    map[tabId] = { options: sanitizeSplitOptions(getSplitRawOptions(message)) };
  } else {
    delete map[tabId];
  }
  await chrome.storage.session.set({ [SPLIT_REOPEN_STORAGE_KEY]: map });
  return { stored: true };
}

async function handleGetSplitReopenMessage(message, sender) {
  const tabId = normalizeTabId(sender?.tab?.id);
  if (!Number.isInteger(tabId)) return { reopen: false };

  const map = await getSplitReopenMap();
  const record = map[tabId];
  if (!isPlainObject(record)) return { reopen: false };
  return { reopen: true, options: sanitizeSplitOptions(isPlainObject(record.options) ? record.options : {}) };
}

async function getSplitReopenMap() {
  const stored = await chrome.storage.session.get({ [SPLIT_REOPEN_STORAGE_KEY]: {} });
  return isPlainObject(stored[SPLIT_REOPEN_STORAGE_KEY]) ? stored[SPLIT_REOPEN_STORAGE_KEY] : {};
}

async function clearSplitReopenForTab(tabId) {
  const normalizedTabId = normalizeTabId(tabId);
  if (!Number.isInteger(normalizedTabId)) return;
  const map = await getSplitReopenMap();
  if (!(normalizedTabId in map)) return;
  delete map[normalizedTabId];
  await chrome.storage.session.set({ [SPLIT_REOPEN_STORAGE_KEY]: map });
}

async function handleCommand(command) {
  const viewMode = COMMAND_VIEW_MODES[command];
  if (!viewMode) return;

  const tab = await getActiveTabForCommand();
  if (!Number.isInteger(tab?.id) || !isSupportedPageUrl(tab.url)) return;

  const status = await sendTabMessageWithInjection(tab.id, { type: "GET_PAGE_STATUS" });
  if (status?.viewMode === viewMode) {
    await sendTabMessageWithInjection(tab.id, { type: "CLEAR_TRANSLATIONS" });
    return;
  }

  if (status?.viewMode) {
    await sendTabMessageWithInjection(tab.id, { type: "CLEAR_TRANSLATIONS" });
  }

  const options = await getCommandTranslationOptions(viewMode);
  const payload = {
    type: viewMode === "split" ? "START_IN_PAGE_SPLIT" : "TRANSLATE_PAGE",
    options
  };
  const response = await sendTabMessageWithInjection(tab.id, payload);
  if (!response?.ok) {
    throw new Error(response?.error || "단축키 번역을 실행하지 못했습니다.");
  }
}

async function getActiveTabForCommand() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getCommandTranslationOptions(viewMode) {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  return {
    ...DEFAULT_SETTINGS,
    ...sanitizeSettings(stored),
    viewMode,
    displayMode: viewMode === "split" ? "replace" : "below",
    translateScope: "viewport",
    enabled: true
  };
}

async function setupActionContextMenu() {
  await removeActionContextMenu();
  await new Promise((resolve, reject) => {
    chrome.contextMenus.create({
      id: ACTION_CONTEXT_MENU_SETTINGS_ID,
      title: "상세 설정 열기",
      contexts: ["action"]
    }, () => {
      const error = chrome.runtime.lastError;
      if (!error || String(error.message).includes("duplicate id")) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function removeActionContextMenu() {
  return new Promise((resolve) => {
    chrome.contextMenus.remove(ACTION_CONTEXT_MENU_SETTINGS_ID, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function getSplitRawOptions(message) {
  return isPlainObject(message.options) ? message.options : {};
}

function sanitizeSplitOptions(options = {}) {
  const input = isPlainObject(options) ? options : {};
  const safe = sanitizeOptions(input);

  safe.viewMode = ALLOWED_SPLIT_VIEW_MODES.has(input.viewMode) ? input.viewMode : "split";
  safe.displayMode = ALLOWED_SPLIT_DISPLAY_MODES.has(input.displayMode) ? input.displayMode : "replace";
  safe.translateScope = ALLOWED_SPLIT_SCOPES.has(input.translateScope) ? input.translateScope : DEFAULT_SETTINGS.translateScope;
  if (typeof input.skipTranslated === "boolean") safe.skipTranslated = input.skipTranslated;
  if (Number.isFinite(Number(input.batchSize))) safe.batchSize = clamp(Number(input.batchSize), 1, MAX_TRANSLATION_BATCH_SIZE);
  safe.enabled = true;

  return safe;
}

function normalizeTabId(value) {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

async function getSettings(overrides = {}) {
  await migrateSecretsToLocal();
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const secrets = await chrome.storage.local.get(Object.keys(SECRET_DEFAULTS));
  return { ...DEFAULT_SETTINGS, ...SECRET_DEFAULTS, ...sanitizeSettings(stored), ...secrets, ...sanitizeOptions(overrides) };
}

async function migrateSecretsToLocal() {
  if (secretsMigrationReady) return secretsMigrationReady;

  secretsMigrationReady = migrateSecretsToLocalOnce().catch((error) => {
    secretsMigrationReady = null;
    throw error;
  });

  return secretsMigrationReady;
}

async function migrateSecretsToLocalOnce() {
  const secretKeys = Object.keys(SECRET_DEFAULTS);
  const legacy = await chrome.storage.sync.get(secretKeys);
  const nextSecrets = Object.fromEntries(
    Object.entries(legacy).filter(([, value]) => typeof value === "string" && value.length > 0)
  );
  const legacyKeys = secretKeys.filter((key) => Object.prototype.hasOwnProperty.call(legacy, key));

  if (Object.keys(nextSecrets).length > 0) {
    await chrome.storage.local.set(nextSecrets);
  }
  if (legacyKeys.length > 0) {
    await chrome.storage.sync.remove(legacyKeys);
  }
}

async function translateBatch(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const settings = await getSettings(options);
  const startedAt = Date.now();
  const requestMeta = buildRequestMeta(texts, settings);

  try {
    const result = await translateBatchWithProvider(texts, settings);
    // Echo detection only makes sense for the LLM providers that can hand the source text
    // back. Deterministic translators (Google/Microsoft/MyMemory) legitimately leave proper
    // nouns untranslated, so running it on them would null real results and leave the block
    // stuck. Skip them.
    if (ECHO_PRONE_PROVIDERS.has(settings.provider)) {
      result.translations = dropEchoedTranslations(result.translations, texts, settings);
    }
    await recordTranslationLog({
      ...requestMeta,
      status: "success",
      durationMs: Date.now() - startedAt,
      outputCharCount: result.translations.join("").length,
      outputEstimatedTokens: estimateTokens(result.translations.join("")),
      outputPreviews: result.translations.map((text) => String(text || "").slice(0, 240)),
      usage: result.usage || null
    }, settings);
    return result.translations;
  } catch (error) {
    const errorOutputText = getTranslationErrorOutputText(error);
    const errorLogEntry = {
      ...requestMeta,
      status: "error",
      durationMs: Date.now() - startedAt,
      error: sanitizeError(error),
      usage: error?.translationUsage || null
    };

    if (errorOutputText) {
      errorLogEntry.outputCharCount = errorOutputText.length;
      errorLogEntry.outputEstimatedTokens = estimateTokens(errorOutputText);
      errorLogEntry.outputPreviews = [errorOutputText.slice(0, 240)];
    }

    await recordTranslationLog(errorLogEntry, settings);
    throw error;
  }
}

async function translateBatchWithProvider(texts, settings) {
  switch (settings.provider) {
    case "google":
      return translateWithGoogle(texts, settings);
    case "microsoft":
      return translateWithMicrosoft(texts, settings);
    case "zhipu":
    case "gpt":
    case "solar":
    case "openai":
      return translateWithOpenAICompatible(texts, getOpenAICompatibleSettings(settings));
    case "gemini":
      return translateWithGemini(texts, settings);
    case "claude":
      return translateWithClaude(texts, settings);
    case "mymemory":
    default:
      return translateWithMyMemory(texts, settings);
  }
}

function getOpenAICompatibleSettings(settings) {
  const providerConfig = OPENAI_COMPATIBLE_PROVIDER_CONFIG[settings.provider] || OPENAI_COMPATIBLE_PROVIDER_CONFIG.openai;
  const overrides = {
    providerLabel: providerConfig.providerLabel
  };

  if (providerConfig.endpointKey) overrides.openaiEndpoint = settings[providerConfig.endpointKey];
  if (providerConfig.apiKeyKey) overrides.openaiApiKey = settings[providerConfig.apiKeyKey];
  if (providerConfig.modelKey) overrides.openaiModel = settings[providerConfig.modelKey];

  return { ...settings, ...overrides };
}

function buildRequestMeta(texts, settings) {
  const inputText = texts.join("\n");
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    provider: settings.provider,
    model: getActiveModel(settings),
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    textCount: texts.length,
    inputCharCount: inputText.length,
    inputEstimatedTokens: estimateTokens(inputText),
    previews: texts.map((text) => text.slice(0, 240))
  };
}

function getActiveModel(settings) {
  const modelKey = PROVIDER_MODEL_KEYS[settings.provider];
  if (modelKey) return settings[modelKey];
  return PROVIDER_MODEL_LABELS[settings.provider] || PROVIDER_MODEL_LABELS.mymemory;
}

function estimateTokens(text) {
  if (!text) return 0;
  const cjkChars = (text.match(/[\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const nonCjkChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 0.7 + nonCjkChars / 4);
}

async function recordTranslationLog(entry, settings) {
  if (!settings.keepTextLogs) return;
  const write = logWriteQueue.then(async () => {
    const stored = await chrome.storage.local.get({ translationLogs: [] });
    const logs = Array.isArray(stored.translationLogs) ? stored.translationLogs : [];
    logs.unshift(entry);
    await chrome.storage.local.set({ translationLogs: logs.slice(0, 100) });
  });
  // Keep the serialized queue chainable even if this write rejects: a rejected
  // logWriteQueue would otherwise stay rejected forever, skipping every future
  // write and making `await` here throw — which would surface a *successful*
  // translation as a failure. A logging failure must never break translation.
  logWriteQueue = write.catch(() => {});
  try {
    await write;
  } catch (error) {
    console.warn("Failed to record translation log", sanitizeError(error));
  }
}

function normalizeTexts(texts) {
  if (!Array.isArray(texts)) return [];
  return texts
    .slice(0, MAX_TRANSLATION_BATCH_SIZE)
    .map((text) => String(text || "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0)
    .map((text) => text.slice(0, MAX_TRANSLATION_TEXT_LENGTH));
}

function sanitizeOptions(options = {}) {
  return sanitizeSettings(options);
}

function sanitizeSettings(options = {}) {
  const input = isPlainObject(options) ? options : {};
  const safe = {};

  copyAllowedValue(safe, input, "provider", ALLOWED_PROVIDERS);
  copyAllowedValue(safe, input, "targetLang", ALLOWED_LANGS);
  copyAllowedValue(safe, input, "sourceLang", ALLOWED_LANGS);
  for (const [key, values] of Object.entries(ALLOWED_MODELS)) {
    copyAllowedValue(safe, input, key, values);
  }
  if (typeof input.microsoftRegion === "string" && /^[a-z0-9-]{0,32}$/i.test(input.microsoftRegion)) {
    safe.microsoftRegion = input.microsoftRegion;
  }
  if (typeof input.openaiEndpoint === "string" && isAllowedOpenAICompatibleEndpoint(input.openaiEndpoint)) {
    safe.openaiEndpoint = input.openaiEndpoint;
  }
  if (typeof input.openaiModel === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(input.openaiModel)) {
    safe.openaiModel = input.openaiModel;
  }
  if (typeof input.keepTextLogs === "boolean") safe.keepTextLogs = input.keepTextLogs;

  return safe;
}

function copyAllowedValue(target, source, key, allowedValues) {
  if (allowedValues.has(source[key])) target[key] = source[key];
}

function sanitizeError(error) {
  const message = error?.message || "Translation failed";
  return message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 240);
}

function getTranslationErrorOutputText(error) {
  return typeof error?.translationOutputText === "string" ? error.translationOutputText : "";
}

function buildGoogleTranslateUrl(text, source, target) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", source);
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);
  return url.toString();
}

function buildMyMemoryTranslateUrl(text, source, target) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${source}|${target}`);
  return url.toString();
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const FETCH_MAX_RETRIES = 2;
const FETCH_BASE_RETRY_DELAY_MS = 500;
const FETCH_MAX_RETRY_DELAY_MS = 8000;
const FETCH_TIMEOUT_MS = 30000;

// Transient provider failures (rate limits, 5xx, dropped connections) recover on a short
// exponential backoff, so they don't surface as "translation failed". Non-retryable
// responses (auth, bad request, …) still fail fast since a retry can't help.
async function fetchJsonOrThrow(resource, init, providerLabel) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(resource, init);
    } catch (error) {
      if (attempt >= FETCH_MAX_RETRIES) throw normalizeFetchError(error, providerLabel);
      await delay(getRetryDelay(attempt, null));
      continue;
    }

    if (response.ok) return response.json();

    if (RETRYABLE_HTTP_STATUSES.has(response.status) && attempt < FETCH_MAX_RETRIES) {
      await delay(getRetryDelay(attempt, response.headers.get("Retry-After")));
      continue;
    }

    throw new Error(`${providerLabel} request failed: ${response.status}`);
  }
}

// Without a timeout a hung provider connection never settles, so the request's
// `isTranslating`/queue state stays stuck (notably the split-view mirror pass) until
// the MV3 worker is eventually recycled. Abort each attempt after FETCH_TIMEOUT_MS;
// the abort surfaces as a transient error so the normal retry/backoff handles it.
function fetchWithTimeout(resource, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(resource, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function normalizeFetchError(error, providerLabel) {
  if (error?.name === "AbortError") {
    return new Error(`${providerLabel} request timed out`);
  }
  return error;
}

function getRetryDelay(attempt, retryAfterHeader) {
  const headerMs = parseRetryAfterMs(retryAfterHeader);
  if (headerMs != null) return Math.min(headerMs, FETCH_MAX_RETRY_DELAY_MS);
  const backoffMs = FETCH_BASE_RETRY_DELAY_MS * (2 ** attempt);
  const jitterMs = Math.floor(Math.random() * 250);
  return Math.min(backoffMs + jitterMs, FETCH_MAX_RETRY_DELAY_MS);
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keyless REST providers (Google, MyMemory) translate one text per request. Settle the
// requests independently so a single failed or empty response doesn't discard the rest of
// the batch: failed items become null (the content script keeps the original text and can
// retry later) while every other text still renders. Order and length are preserved so the
// caller can line texts up with translations. Only if every item failed is the batch treated
// as an error so it surfaces instead of silently translating nothing.
function settleTranslations(results, providerLabel) {
  const translations = results.map((result) => (result.status === "fulfilled" ? result.value : null));
  if (translations.every((value) => value == null)) {
    const firstRejection = results.find((result) => result.status === "rejected");
    throw firstRejection?.reason instanceof Error
      ? firstRejection.reason
      : new Error(`${providerLabel} request failed`);
  }
  return translations;
}

async function translateWithGoogle(texts, settings) {
  const source = settings.sourceLang === "auto" ? "auto" : normalizeGoogleLang(settings.sourceLang);
  const target = normalizeGoogleLang(settings.targetLang);

  const results = await Promise.allSettled(texts.map(async (text) => {
    const payload = await fetchJsonOrThrow(
      buildGoogleTranslateUrl(text, source, target),
      undefined,
      "Google Translate"
    );
    const translated = Array.isArray(payload?.[0])
      ? payload[0].map((part) => part?.[0] || "").join("")
      : "";
    return cleanTranslation(translated) || null;
  }));

  return { translations: settleTranslations(results, "Google Translate") };
}

async function translateWithMyMemory(texts, settings) {
  // MyMemory's langpair has no auto-detect; the previous code silently forced "en", so a
  // Japanese/German page was translated as if it were English. Fail loudly instead and ask
  // the user to pick the source language explicitly.
  if (settings.sourceLang === "auto") {
    throw new Error("MyMemory는 원본 언어 자동 감지를 지원하지 않습니다. 설정에서 원본 언어를 직접 선택하세요.");
  }
  const source = settings.sourceLang;
  const target = settings.targetLang;

  const results = await Promise.allSettled(texts.map(async (text) => {
    const payload = await fetchJsonOrThrow(buildMyMemoryTranslateUrl(text, source, target), undefined, "MyMemory");
    const translated = payload?.responseData?.translatedText;
    return cleanTranslation(translated || "") || null;
  }));

  return { translations: settleTranslations(results, "MyMemory") };
}

async function translateWithMicrosoft(texts, settings) {
  if (!settings.microsoftApiKey) {
    throw new Error("Microsoft Translator API key is missing. Set it in extension options.");
  }

  const url = new URL("https://api.cognitive.microsofttranslator.com/translate");
  url.searchParams.set("api-version", "3.0");
  url.searchParams.set("to", normalizeMicrosoftLang(settings.targetLang));
  if (settings.sourceLang !== "auto") {
    url.searchParams.set("from", normalizeMicrosoftLang(settings.sourceLang));
  }

  const headers = {
    "Content-Type": "application/json",
    "Ocp-Apim-Subscription-Key": settings.microsoftApiKey
  };
  if (settings.microsoftRegion) {
    headers["Ocp-Apim-Subscription-Region"] = settings.microsoftRegion;
  }

  const payload = await fetchJsonOrThrow(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(texts.map((text) => ({ Text: text })))
  }, "Microsoft Translator");
  return {
    translations: payload.map((item) => cleanTranslation(item?.translations?.[0]?.text || ""))
  };
}

async function translateWithOpenAICompatible(texts, settings) {
  if (!settings.openaiApiKey) {
    throw new Error(`${settings.providerLabel || "OpenAI-compatible"} API key is missing. Set it in extension options.`);
  }

  const payload = await fetchJsonOrThrow(settings.openaiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify(buildOpenAICompatibleRequestBody(texts, settings))
  }, settings.providerLabel || "OpenAI-compatible");

  const content = payload?.choices?.[0]?.message?.content;
  return {
    translations: parseTranslations(content, texts.length, payload?.usage),
    usage: normalizeOpenAIUsage(payload?.usage)
  };
}

function buildOpenAICompatibleRequestBody(texts, settings) {
  const responseFormat = getOpenAICompatibleResponseFormat(settings);
  const body = {
    model: settings.openaiModel,
    temperature: 0.1,
    max_tokens: OPENAI_COMPATIBLE_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: responseFormat ? TRANSLATION_JSON_OBJECT_INSTRUCTION : TRANSLATION_JSON_ARRAY_INSTRUCTION
      },
      {
        role: "user",
        content: JSON.stringify({
          target_language: settings.targetLang,
          source_language: settings.sourceLang,
          expected_count: texts.length,
          texts
        })
      }
    ]
  };

  if (responseFormat) body.response_format = responseFormat;
  return body;
}

function getOpenAICompatibleResponseFormat(settings) {
  if (!isOfficialOpenAIEndpoint(settings.openaiEndpoint)) return null;

  return {
    type: "json_schema",
    json_schema: {
      name: "translation_batch",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          translations: {
            type: "array",
            description: "Translated strings in the same length and order as the input texts.",
            items: { type: "string" }
          }
        },
        required: ["translations"]
      }
    }
  };
}

function isOfficialOpenAIEndpoint(endpoint) {
  try {
    return new URL(endpoint).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

async function translateWithGemini(texts, settings) {
  if (!settings.geminiApiKey) {
    throw new Error("Gemini API key is missing. Set it in extension options.");
  }

  const endpoint = `${settings.geminiEndpoint.replace(/\/$/, "")}/models/${encodeURIComponent(settings.geminiModel)}:generateContent`;
  const payload = await fetchJsonOrThrow(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": settings.geminiApiKey
    },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: buildTranslationPrompt(settings.targetLang, settings.sourceLang, texts)
            }
          ]
        }
      ]
    })
  }, "Gemini");

  const content = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  return {
    translations: parseTranslations(content, texts.length),
    usage: normalizeGeminiUsage(payload?.usageMetadata)
  };
}

async function translateWithClaude(texts, settings) {
  if (!settings.claudeApiKey) {
    throw new Error("Claude API key is missing. Set it in extension options.");
  }

  const payload = await fetchJsonOrThrow(settings.claudeEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.claudeApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: settings.claudeModel,
      max_tokens: 4096,
      temperature: 0.1,
      system: CLAUDE_SYSTEM_INSTRUCTION,
      messages: [
        {
          role: "user",
          content: buildTranslationPrompt(settings.targetLang, settings.sourceLang, texts)
        }
      ]
    })
  }, "Claude");

  const content = payload?.content?.map((part) => part.text || "").join("");
  return {
    translations: parseTranslations(content, texts.length),
    usage: normalizeClaudeUsage(payload?.usage)
  };
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    totalTokens: usage.total_tokens ?? null
  };
}

function normalizeGeminiUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.promptTokenCount ?? null,
    outputTokens: usage.candidatesTokenCount ?? null,
    totalTokens: usage.totalTokenCount ?? null
  };
}

function normalizeClaudeUsage(usage) {
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? null;
  const outputTokens = usage.output_tokens ?? null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null
  };
}

function parseJsonValue(value) {
  if (!value) return null;
  const text = String(value).trim();
  const candidates = [
    text,
    extractFencedJson(text),
    extractJsonSlice(text, "{", "}"),
    extractJsonSlice(text, "[", "]")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next likely JSON slice.
    }
  }

  return null;
}

function extractFencedJson(value) {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || null;
}

function extractJsonSlice(value, open, close) {
  const start = value.indexOf(open);
  const end = value.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  return value.slice(start, end + 1);
}

function parseTranslations(content, expectedLength, usage = null) {
  const parsed = parseJsonValue(content);
  const translations = normalizeTranslationArray(parsed) || normalizeSingleTranslationObject(parsed, expectedLength);
  if (!translations || translations.length !== expectedLength) {
    throw createTranslationParseError(content, usage);
  }

  return translations.map((item) => cleanTranslation(item));
}

function normalizeSingleTranslationObject(value, expectedLength) {
  if (expectedLength !== 1 || !isPlainObject(value)) return null;
  const translation = getTranslationItemText(value);
  return translation == null ? null : [translation];
}

function normalizeTranslationArray(value) {
  if (Array.isArray(value)) return normalizeTranslationItems(value);
  if (!isPlainObject(value)) return null;

  for (const key of TRANSLATION_ARRAY_RESPONSE_KEYS) {
    const normalized = normalizeTranslationArray(value[key]);
    if (normalized) return normalized;
  }

  return null;
}

function normalizeTranslationItems(items) {
  const normalized = [];

  for (const item of items) {
    if (item == null) {
      normalized.push("");
      continue;
    }
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      normalized.push(String(item));
      continue;
    }
    if (isPlainObject(item)) {
      const translation = getTranslationItemText(item);
      if (translation != null) {
        normalized.push(translation);
        continue;
      }
    }
    return null;
  }

  return normalized;
}

function getTranslationItemText(item) {
  for (const key of TRANSLATION_ITEM_RESPONSE_KEYS) {
    if (typeof item[key] === "string") return item[key];
  }

  return null;
}

function createTranslationParseError(content, usage = null) {
  const error = new Error("Translation response did not include the expected number of translations.");
  error.translationOutputText = typeof content === "string" ? content : "";
  error.translationUsage = normalizeOpenAIUsage(usage);
  return error;
}

function buildTranslationInstruction(outputInstruction) {
  return [
    TRANSLATION_UNIT_INSTRUCTION,
    TRANSLATION_PRESERVE_INSTRUCTION,
    outputInstruction,
    TRANSLATION_ARRAY_ITEM_INSTRUCTION
  ].join(" ");
}

function buildTranslationPrompt(targetLang, sourceLang, texts) {
  return JSON.stringify({
    instruction: buildTranslationInstruction(
      "Return only a JSON array of translated strings. Return exactly one translated string for each input string."
    ),
    target_language: targetLang,
    source_language: sourceLang,
    expected_count: texts.length,
    texts
  });
}

// Non-Latin targets have a distinct script, so a real translation always contains some of
// it. We use that to recognise an *untranslated echo* (the provider — usually a weak LLM —
// just handed the source text back).
const ECHO_PRONE_PROVIDERS = new Set(["zhipu", "gpt", "solar", "openai", "gemini", "claude"]);

const TARGET_SCRIPT_PATTERNS = {
  ko: /[가-힯]/,
  ja: /[぀-ヿ㐀-鿿]/,
  "zh-CN": /[㐀-鿿]/,
  "zh-TW": /[㐀-鿿]/
};

// A provider that returns the source text verbatim hasn't translated it; rendering that just
// shows the original twice ("원문 그대로"). For a non-Latin target we can detect it reliably —
// same text, multiple words, and no target-script character — and null it so the content
// script keeps the original in place and retries later instead of showing a fake translation.
function dropEchoedTranslations(translations, texts, settings) {
  if (!Array.isArray(translations)) return translations;
  const targetPattern = TARGET_SCRIPT_PATTERNS[settings.targetLang];
  if (!targetPattern) return translations;

  return translations.map((translation, index) => {
    if (translation == null) return translation;
    const source = texts[index] || "";
    if (
      normalizeEcho(translation) === normalizeEcho(source) &&
      String(source).trim().split(/\s+/).length >= 2 &&
      !targetPattern.test(translation)
    ) {
      return null;
    }
    return translation;
  });
}

function normalizeEcho(text) {
  return String(text || "").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}

function cleanTranslation(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function normalizeGoogleLang(lang) {
  return lang === "zh-CN" ? "zh-CN" : lang === "zh-TW" ? "zh-TW" : lang;
}

function normalizeMicrosoftLang(lang) {
  if (lang === "zh-CN") return "zh-Hans";
  if (lang === "zh-TW") return "zh-Hant";
  return lang;
}
