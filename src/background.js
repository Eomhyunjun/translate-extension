importScripts("defaults.js");

const DEFAULT_SETTINGS = globalThis.BIT_DEFAULT_SETTINGS;
const SECRET_DEFAULTS = globalThis.BIT_SECRET_DEFAULTS;

let logWriteQueue = Promise.resolve();
const ACTION_CONTEXT_MENU_SETTINGS_ID = "bit-open-settings";
const SPLIT_SESSIONS_STORAGE_KEY = "splitSessions";
const SPLIT_SCROLL_ECHO_WINDOW_MS = 700;
const SPLIT_SCROLL_LOOSE_ECHO_WINDOW_MS = 180;
const splitSessionsByTab = new Map();
const pendingSplitTargets = new Map();
let splitSessionsReady = null;
let secretsMigrationReady = null;

const MESSAGE_TYPES = {
  CLEAR_SPLIT_SESSION: "CLEAR_SPLIT_SESSION",
  SPLIT_SCROLL: "SPLIT_SCROLL",
  TRANSLATE_BATCH: "TRANSLATE_BATCH"
};

const RUNTIME_MESSAGE_HANDLERS = {
  [MESSAGE_TYPES.CLEAR_SPLIT_SESSION]: handleClearSplitSessionMessage,
  [MESSAGE_TYPES.SPLIT_SCROLL]: relaySplitScroll,
  [MESSAGE_TYPES.TRANSLATE_BATCH]: handleTranslateBatchMessage
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

const TRANSLATION_JSON_ARRAY_INSTRUCTION =
  "Translate each input string faithfully. Preserve meaning, names, numbers, punctuation, and inline whitespace. Return only a JSON array of translated strings with the same length and order as the input.";
const TRANSLATION_JSON_OBJECT_INSTRUCTION =
  "Translate each input string faithfully. Preserve meaning, names, numbers, punctuation, and inline whitespace. Return only JSON with this shape: {\"translations\":[\"...\"]}. The translations array must have the same length and order as the input texts.";
const CLAUDE_SYSTEM_INSTRUCTION =
  "Translate faithfully. Preserve meaning, names, numbers, punctuation, and inline whitespace. Return only a JSON array of translated strings.";
const TRANSLATION_ARRAY_RESPONSE_KEYS = Object.freeze([
  "translations",
  "translatedTexts",
  "translated_texts",
  "results",
  "items"
]);
const TRANSLATION_ITEM_RESPONSE_KEYS = Object.freeze([
  "translation",
  "translatedText",
  "translated_text",
  "text",
  "output"
]);

const SPLIT_SCROLL_SIGNATURE_KEYS = [
  "blockId",
  "scrollX",
  "scrollY",
  "pageXOffset",
  "pageYOffset",
  "scrollLeft",
  "scrollTop",
  "left",
  "top",
  "x",
  "y",
  "ratio",
  "xRatio",
  "scrollRatio",
  "progress",
  "percent",
  "anchorKey",
  "anchorOccurrence",
  "anchorViewportTop",
  "containerKey"
];

const SPLIT_SCROLL_VOLATILE_KEYS = new Set([
  "type",
  "tabId",
  "sourceTabId",
  "targetTabId",
  "fromTabId",
  "toTabId",
  "originTabId",
  "relayId",
  "relayed",
  "_splitRelay",
  "timestamp",
  "ts"
]);

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  activatePendingSplitTarget(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleSplitTabRemoved(tabId).catch(() => {});
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

function handleClearSplitSessionMessage(message) {
  return clearSplitSession(message.tabId);
}

async function handleTranslateBatchMessage(message) {
  const translations = await translateBatch(normalizeTexts(message.texts), sanitizeOptions(message.options));
  return { translations };
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

async function startSplitMode(message, sender) {
  throw new Error("Legacy split-window mode is disabled. Use in-page split mode.");
}

function getSplitSourceTabId(message, sender) {
  return normalizeTabId(message.sourceTabId ?? message.tabId ?? sender?.tab?.id);
}

function getSplitRawOptions(message) {
  return isPlainObject(message.options) ? message.options : {};
}

async function getSupportedSplitSourceTab(tabId) {
  const sourceTab = await chrome.tabs.get(tabId);
  if (!isSupportedPageUrl(sourceTab.url)) {
    throw new Error("This page cannot be opened in split translation mode.");
  }
  return sourceTab;
}

function createSplitSession(sourceTabId, sourceTab, targetTab, options) {
  const targetTabId = normalizeTabId(targetTab.id);
  if (!Number.isInteger(targetTabId)) throw new Error("Failed to create translated split tab.");

  return {
    sourceTabId,
    targetTabId,
    sourceWindowId: normalizeTabId(sourceTab.windowId),
    targetWindowId: normalizeTabId(targetTab.windowId),
    url: sourceTab.url,
    options,
    createdAt: Date.now(),
    echoSuppressions: []
  };
}

async function registerSplitSession(session) {
  cacheSplitSession(session);
  pendingSplitTargets.set(session.targetTabId, session);
  await persistSplitSessions();
}

function notifySplitSource(session) {
  chrome.tabs.sendMessage(session.sourceTabId, {
    type: "START_SPLIT_SOURCE",
    sourceTabId: session.sourceTabId,
    targetTabId: session.targetTabId,
    splitRole: "source",
    options: session.options
  }).catch(() => {});
}

function activateSplitTargetWhenReady(session, targetTab) {
  if (targetTab.status === "complete") {
    activatePendingSplitTarget(session.targetTabId).catch(() => {});
  }
}

function buildSplitStartedResponse(session) {
  return {
    translatedCount: 0,
    skippedCount: 0,
    sourceTabId: session.sourceTabId,
    targetTabId: session.targetTabId,
    targetWindowId: session.targetWindowId
  };
}

async function activatePendingSplitTarget(tabId) {
  await ensureSplitSessionsLoaded();
  const session = pendingSplitTargets.get(tabId) || splitSessionsByTab.get(tabId);
  if (!session || session.targetTabId !== tabId) return;

  const response = await sendTabMessageWithRetry(tabId, {
    type: "START_SPLIT_TARGET",
    sourceTabId: session.sourceTabId,
    targetTabId: session.targetTabId,
    splitRole: "target",
    options: session.options
  }, { attempts: 12, delayMs: 350 });

  if (response?.ok || response == null) {
    pendingSplitTargets.delete(tabId);
  }
}

async function relaySplitScroll(message, sender) {
  const senderTabId = getSplitScrollSenderTabId(message, sender);
  if (!Number.isInteger(senderTabId)) return { relayed: false, ignored: true, reason: "missing-sender" };
  if (isRelayedSplitScrollMessage(message)) {
    return { relayed: false, ignored: true, reason: "already-relayed" };
  }

  await ensureSplitSessionsLoaded();
  const session = splitSessionsByTab.get(senderTabId);
  if (!session) return { relayed: false, ignored: true, reason: "no-session" };

  const targetTabId = getSplitPeerTabId(session, senderTabId);
  if (!Number.isInteger(targetTabId)) return { relayed: false, ignored: true, reason: "no-target" };
  if (shouldSuppressSplitScrollEcho(session, senderTabId, message)) {
    return { relayed: false, ignored: true, reason: "echo-suppressed" };
  }

  const relayId = sanitizeRelayId(message.relayId) || makeSplitRelayId(senderTabId, targetTabId);
  const payload = buildSplitScrollRelayPayload(message, session, senderTabId, targetTabId, relayId);
  markSplitScrollEchoSuppression(session, targetTabId, message);

  await chrome.tabs.sendMessage(targetTabId, payload).catch(() => {});
  return { relayed: true, toTabId: targetTabId, relayId };
}

function getSplitScrollSenderTabId(message, sender) {
  return normalizeTabId(sender?.tab?.id ?? message.fromTabId ?? message.tabId);
}

function isRelayedSplitScrollMessage(message) {
  return message.relayed === true || message._splitRelay === true;
}

async function clearSplitSession(tabId, { notifyTabs = true } = {}) {
  await ensureSplitSessionsLoaded();
  const normalizedTabId = normalizeTabId(tabId);
  if (!Number.isInteger(normalizedTabId)) return { cleared: false };

  const session = splitSessionsByTab.get(normalizedTabId);
  if (!session) return { cleared: false };

  deleteCachedSplitSession(session);
  await persistSplitSessions();

  if (!notifyTabs) return { cleared: true };

  await notifySplitSessionCleared(session);

  return { cleared: true };
}

async function handleSplitTabRemoved(tabId) {
  await ensureSplitSessionsLoaded();
  const normalizedTabId = normalizeTabId(tabId);
  if (!Number.isInteger(normalizedTabId)) return;

  const session = splitSessionsByTab.get(normalizedTabId);
  if (!session) return;

  const remainingTabId = getSplitPeerTabId(session, normalizedTabId);
  await clearSplitSession(normalizedTabId, { notifyTabs: false });
  if (Number.isInteger(remainingTabId)) {
    await chrome.tabs.sendMessage(remainingTabId, { type: "CLEAR_TRANSLATIONS" }).catch(() => {});
  }
}

function deleteCachedSplitSession(session) {
  splitSessionsByTab.delete(session.sourceTabId);
  splitSessionsByTab.delete(session.targetTabId);
  pendingSplitTargets.delete(session.targetTabId);
}

function notifySplitSessionCleared(session) {
  return Promise.allSettled([
    chrome.tabs.sendMessage(session.sourceTabId, { type: "CLEAR_TRANSLATIONS" }),
    chrome.tabs.sendMessage(session.targetTabId, { type: "CLEAR_TRANSLATIONS" })
  ]);
}

function getSplitPeerTabId(session, tabId) {
  if (tabId === session.sourceTabId) return session.targetTabId;
  if (tabId === session.targetTabId) return session.sourceTabId;
  return null;
}

async function sendTabMessageWithRetry(tabId, message, { attempts = 6, delayMs = 250 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await delay(delayMs);
    }
  }
  throw lastError || new Error("Could not connect to tab.");
}

async function ensureSplitSessionsLoaded() {
  if (!splitSessionsReady) {
    splitSessionsReady = chrome.storage.session
      .get({ [SPLIT_SESSIONS_STORAGE_KEY]: [] })
      .then((stored) => {
        splitSessionsByTab.clear();
        const sessions = Array.isArray(stored[SPLIT_SESSIONS_STORAGE_KEY])
          ? stored[SPLIT_SESSIONS_STORAGE_KEY]
          : [];
        sessions.forEach((record) => {
          const session = normalizeSplitSessionRecord(record);
          if (session) cacheSplitSession(session);
        });
      });
  }

  await splitSessionsReady;
}

function normalizeSplitSessionRecord(record) {
  if (!isPlainObject(record)) return null;
  const sourceTabId = normalizeTabId(record.sourceTabId);
  const targetTabId = normalizeTabId(record.targetTabId);
  if (!Number.isInteger(sourceTabId) || !Number.isInteger(targetTabId) || sourceTabId === targetTabId) return null;

  return {
    sourceTabId,
    targetTabId,
    sourceWindowId: normalizeTabId(record.sourceWindowId),
    targetWindowId: normalizeTabId(record.targetWindowId),
    url: typeof record.url === "string" ? record.url : "",
    options: sanitizeSplitOptions(isPlainObject(record.options) ? record.options : {}),
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    echoSuppressions: []
  };
}

function cacheSplitSession(session) {
  splitSessionsByTab.set(session.sourceTabId, session);
  splitSessionsByTab.set(session.targetTabId, session);
}

async function persistSplitSessions() {
  const seen = new Set();
  const sessions = [];

  for (const session of splitSessionsByTab.values()) {
    const key = `${session.sourceTabId}:${session.targetTabId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({
      sourceTabId: session.sourceTabId,
      targetTabId: session.targetTabId,
      sourceWindowId: session.sourceWindowId,
      targetWindowId: session.targetWindowId,
      url: session.url,
      options: session.options,
      createdAt: session.createdAt
    });
  }

  await chrome.storage.session.set({ [SPLIT_SESSIONS_STORAGE_KEY]: sessions });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSupportedPageUrl(url) {
  return /^(https?|file):\/\//i.test(String(url || ""));
}

function sanitizeSplitOptions(options = {}) {
  const input = isPlainObject(options) ? options : {};
  const safe = sanitizeOptions(input);

  safe.viewMode = ALLOWED_SPLIT_VIEW_MODES.has(input.viewMode) ? input.viewMode : "split";
  safe.displayMode = ALLOWED_SPLIT_DISPLAY_MODES.has(input.displayMode) ? input.displayMode : "replace";
  safe.translateScope = ALLOWED_SPLIT_SCOPES.has(input.translateScope) ? input.translateScope : DEFAULT_SETTINGS.translateScope;
  if (typeof input.skipTranslated === "boolean") safe.skipTranslated = input.skipTranslated;
  if (Number.isFinite(Number(input.batchSize))) safe.batchSize = clamp(Number(input.batchSize), 1, 20);
  safe.enabled = true;

  return safe;
}

function getSplitTargetActiveState(options = {}) {
  if (typeof options.active === "boolean") return options.active;
  if (typeof options.focus === "boolean") return options.focus;
  if (typeof options.activateTarget === "boolean") return options.activateTarget;
  if (options.background === true) return false;
  return true;
}

function buildSplitScrollRelayPayload(message, session, fromTabId, toTabId, relayId) {
  const payload = { ...message };
  delete payload.tabId;
  delete payload.sourceTabId;
  delete payload.targetTabId;
  delete payload.fromTabId;
  delete payload.toTabId;
  delete payload.relayed;
  delete payload._splitRelay;

  return {
    ...payload,
    type: "APPLY_SPLIT_SCROLL",
    sourceTabId: session.sourceTabId,
    targetTabId: session.targetTabId,
    fromTabId,
    toTabId,
    originTabId: normalizeTabId(message.originTabId) ?? fromTabId,
    relayId,
    relayed: true,
    _splitRelay: true
  };
}

function markSplitScrollEchoSuppression(session, tabId, message) {
  pruneSplitScrollEchoSuppressions(session);
  const now = Date.now();
  session.echoSuppressions.push({
    tabId,
    signature: getSplitScrollSignature(message),
    createdAt: now,
    expiresAt: now + SPLIT_SCROLL_ECHO_WINDOW_MS
  });
}

function shouldSuppressSplitScrollEcho(session, tabId, message) {
  pruneSplitScrollEchoSuppressions(session);
  const now = Date.now();
  const signature = getSplitScrollSignature(message);
  const suppressionIndex = session.echoSuppressions.findIndex((suppression) => (
    suppression.tabId === tabId &&
    (suppression.signature === signature || now - suppression.createdAt <= SPLIT_SCROLL_LOOSE_ECHO_WINDOW_MS)
  ));

  if (suppressionIndex === -1) return false;
  session.echoSuppressions.splice(suppressionIndex, 1);
  return true;
}

function pruneSplitScrollEchoSuppressions(session) {
  const now = Date.now();
  session.echoSuppressions = (session.echoSuppressions || []).filter((suppression) => suppression.expiresAt > now);
}

function getSplitScrollSignature(message) {
  const parts = [];

  SPLIT_SCROLL_SIGNATURE_KEYS.forEach((key) => {
    if (!(key in message)) return;
    const value = message[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}:${Math.round(value * 1000) / 1000}`);
    } else if (typeof value === "string" && value.length < 200) {
      parts.push(`${key}:${value}`);
    } else if (typeof value === "boolean") {
      parts.push(`${key}:${value}`);
    }
  });

  if (parts.length > 0) return parts.join("|");
  return stableStringifyWithoutVolatileKeys(message);
}

function stableStringifyWithoutVolatileKeys(value) {
  const safe = {};

  Object.keys(value || {}).sort().forEach((key) => {
    if (SPLIT_SCROLL_VOLATILE_KEYS.has(key)) return;
    const item = value[key];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item == null) {
      safe[key] = item;
    }
  });

  return JSON.stringify(safe);
}

function sanitizeRelayId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? value : null;
}

function makeSplitRelayId(fromTabId, toTabId) {
  return `${Date.now()}:${fromTabId}:${toTabId}:${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTabId(value) {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
  logWriteQueue = logWriteQueue.then(async () => {
    const stored = await chrome.storage.local.get({ translationLogs: [] });
    const logs = Array.isArray(stored.translationLogs) ? stored.translationLogs : [];
    logs.unshift(entry);
    await chrome.storage.local.set({ translationLogs: logs.slice(0, 100) });
  });
  await logWriteQueue;
}

function normalizeTexts(texts) {
  if (!Array.isArray(texts)) return [];
  return texts
    .slice(0, 20)
    .map((text) => String(text || "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0)
    .map((text) => text.slice(0, 1600));
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

function isAllowedOpenAICompatibleEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (!url.pathname.endsWith("/chat/completions")) return false;
    return true;
  } catch {
    return false;
  }
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

async function fetchJsonOrThrow(resource, init, providerLabel) {
  const response = await fetch(resource, init);
  if (!response.ok) {
    throw new Error(`${providerLabel} request failed: ${response.status}`);
  }
  return response.json();
}

async function translateWithGoogle(texts, settings) {
  const source = settings.sourceLang === "auto" ? "auto" : normalizeGoogleLang(settings.sourceLang);
  const target = normalizeGoogleLang(settings.targetLang);
  const translations = [];

  for (const text of texts) {
    const payload = await fetchJsonOrThrow(
      buildGoogleTranslateUrl(text, source, target),
      undefined,
      "Google Translate"
    );
    const translated = Array.isArray(payload?.[0])
      ? payload[0].map((part) => part?.[0] || "").join("")
      : "";
    translations.push(cleanTranslation(translated));
  }

  return { translations };
}

async function translateWithMyMemory(texts, settings) {
  const source = settings.sourceLang === "auto" ? "en" : settings.sourceLang;
  const target = settings.targetLang;
  const translations = [];

  for (const text of texts) {
    const payload = await fetchJsonOrThrow(buildMyMemoryTranslateUrl(text, source, target), undefined, "MyMemory");
    const translated = payload?.responseData?.translatedText;
    translations.push(cleanTranslation(translated || ""));
  }

  return { translations };
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
  const translations = normalizeTranslationArray(parsed);
  if (!translations || translations.length !== expectedLength) {
    throw createTranslationParseError(content, usage);
  }

  return translations.map((item) => cleanTranslation(item));
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

function buildTranslationPrompt(targetLang, sourceLang, texts) {
  return JSON.stringify({
    instruction:
      "Translate each input string faithfully. Preserve meaning, names, numbers, punctuation, and inline whitespace. Return only a JSON array of translated strings.",
    target_language: targetLang,
    source_language: sourceLang,
    texts
  });
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
