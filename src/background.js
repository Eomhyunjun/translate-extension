const DEFAULT_SETTINGS = {
  provider: "google",
  targetLang: "ko",
  sourceLang: "en",
  viewMode: "inline",
  displayMode: "below",
  translateScope: "viewport",
  skipTranslated: true,
  keepTextLogs: false,
  batchSize: 6,
  openaiEndpoint: "https://api.openai.com/v1/chat/completions",
  openaiModel: "gpt-4o-mini",
  microsoftRegion: "",
  zhipuEndpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  zhipuModel: "glm-4-flash",
  gptEndpoint: "https://api.openai.com/v1/chat/completions",
  gptModel: "gpt-4.1-mini",
  geminiEndpoint: "https://generativelanguage.googleapis.com/v1beta",
  geminiModel: "gemini-2.0-flash",
  claudeEndpoint: "https://api.anthropic.com/v1/messages",
  claudeModel: "claude-3-5-haiku-latest"
};

let logWriteQueue = Promise.resolve();
const SPLIT_SESSIONS_STORAGE_KEY = "splitSessions";
const SPLIT_SCROLL_ECHO_WINDOW_MS = 700;
const SPLIT_SCROLL_LOOSE_ECHO_WINDOW_MS = 180;
const splitSessionsByTab = new Map();
const pendingSplitTargets = new Map();
let splitSessionsReady = null;

const SECRET_DEFAULTS = {
  openaiApiKey: "",
  microsoftApiKey: "",
  zhipuApiKey: "",
  gptApiKey: "",
  geminiApiKey: "",
  claudeApiKey: ""
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
  await chrome.storage.sync.remove("enabled");
  await migrateSecretsToLocal();
});

chrome.runtime.onStartup.addListener(() => {
  migrateSecretsToLocal();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_SPLIT_MODE") {
    startSplitMode(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: sanitizeError(error) }));
    return true;
  }

  if (message?.type === "CLEAR_SPLIT_SESSION") {
    clearSplitSession(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: sanitizeError(error) }));
    return true;
  }

  if (message?.type === "SPLIT_SCROLL") {
    relaySplitScroll(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: sanitizeError(error) }));
    return true;
  }

  if (message?.type !== "TRANSLATE_BATCH") return false;

  translateBatch(normalizeTexts(message.texts), sanitizeOptions(message.options))
    .then((translations) => sendResponse({ ok: true, translations }))
    .catch((error) => sendResponse({ ok: false, error: sanitizeError(error) }));

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  activatePendingSplitTarget(tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleSplitTabRemoved(tabId).catch(() => {});
});

async function startSplitMode(message, sender) {
  const normalizedSourceTabId = normalizeTabId(message.sourceTabId ?? message.tabId ?? sender?.tab?.id);
  if (!Number.isInteger(normalizedSourceTabId)) throw new Error("Source tab is missing.");

  await ensureSplitSessionsLoaded();
  await clearSplitSession(normalizedSourceTabId);

  const sourceTab = await chrome.tabs.get(normalizedSourceTabId);
  if (!isSupportedPageUrl(sourceTab.url)) {
    throw new Error("This page cannot be opened in split translation mode.");
  }

  const rawOptions = isPlainObject(message.options) ? message.options : {};
  const splitOptions = sanitizeSplitOptions(rawOptions);
  const targetTab = await createSplitTargetTab(sourceTab, rawOptions);
  const targetTabId = normalizeTabId(targetTab.id);
  if (!Number.isInteger(targetTabId)) throw new Error("Failed to create translated split tab.");

  const session = {
    sourceTabId: normalizedSourceTabId,
    targetTabId,
    sourceWindowId: normalizeTabId(sourceTab.windowId),
    targetWindowId: normalizeTabId(targetTab.windowId),
    url: sourceTab.url,
    options: splitOptions,
    createdAt: Date.now(),
    echoSuppressions: []
  };

  cacheSplitSession(session);
  pendingSplitTargets.set(session.targetTabId, session);
  await persistSplitSessions();

  chrome.tabs.sendMessage(session.sourceTabId, {
    type: "START_SPLIT_SOURCE",
    sourceTabId: session.sourceTabId,
    targetTabId: session.targetTabId,
    splitRole: "source",
    options: splitOptions
  }).catch(() => {});

  if (targetTab.status === "complete") {
    activatePendingSplitTarget(session.targetTabId).catch(() => {});
  }

  return {
    translatedCount: 0,
    skippedCount: 0,
    sourceTabId: session.sourceTabId,
    targetTabId: session.targetTabId,
    targetWindowId: session.targetWindowId
  };
}

async function createSplitTargetTab(sourceTab, options = {}) {
  if (options.openInWindow === false || options.target === "tab") {
    const createProperties = {
      url: sourceTab.url,
      active: getSplitTargetActiveState(options),
      windowId: sourceTab.windowId
    };
    if (Number.isInteger(sourceTab.index)) createProperties.index = sourceTab.index + 1;
    if (Number.isInteger(sourceTab.id)) createProperties.openerTabId = sourceTab.id;
    return chrome.tabs.create(createProperties);
  }

  const sourceWindow = await chrome.windows.get(sourceTab.windowId).catch(() => null);
  const createData = {
    url: sourceTab.url,
    focused: getSplitTargetActiveState(options),
    type: "normal"
  };

  if (sourceWindow && Number.isInteger(sourceWindow.left) && Number.isInteger(sourceWindow.width)) {
    const width = Math.max(520, Math.floor(sourceWindow.width / 2));
    const height = Math.max(520, sourceWindow.height || 720);
    createData.left = sourceWindow.left + width;
    createData.top = sourceWindow.top || 0;
    createData.width = width;
    createData.height = height;

    chrome.windows.update(sourceWindow.id, {
      left: sourceWindow.left,
      top: sourceWindow.top || 0,
      width,
      height
    }).catch(() => {});
  }

  const targetWindow = await chrome.windows.create(createData);
  const tabs = targetWindow.tabs?.length
    ? targetWindow.tabs
    : await chrome.tabs.query({ windowId: targetWindow.id, active: true });
  const [targetTab] = tabs;
  if (!targetTab?.id) throw new Error("Failed to create translated split tab.");
  return targetTab;
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
  const senderTabId = normalizeTabId(sender?.tab?.id ?? message.fromTabId ?? message.tabId);
  if (!Number.isInteger(senderTabId)) return { relayed: false, ignored: true, reason: "missing-sender" };
  if (message.relayed === true || message._splitRelay === true) {
    return { relayed: false, ignored: true, reason: "already-relayed" };
  }

  await ensureSplitSessionsLoaded();
  const session = splitSessionsByTab.get(senderTabId);
  if (!session) return { relayed: false, ignored: true, reason: "no-session" };

  const targetTabId = senderTabId === session.sourceTabId ? session.targetTabId : session.sourceTabId;
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

async function clearSplitSession(tabId, { notifyTabs = true } = {}) {
  await ensureSplitSessionsLoaded();
  const normalizedTabId = normalizeTabId(tabId);
  if (!Number.isInteger(normalizedTabId)) return { cleared: false };

  const session = splitSessionsByTab.get(normalizedTabId);
  if (!session) return { cleared: false };

  splitSessionsByTab.delete(session.sourceTabId);
  splitSessionsByTab.delete(session.targetTabId);
  pendingSplitTargets.delete(session.targetTabId);
  await persistSplitSessions();

  if (!notifyTabs) return { cleared: true };

  await Promise.allSettled([
    chrome.tabs.sendMessage(session.sourceTabId, { type: "CLEAR_TRANSLATIONS" }),
    chrome.tabs.sendMessage(session.targetTabId, { type: "CLEAR_TRANSLATIONS" })
  ]);

  return { cleared: true };
}

async function handleSplitTabRemoved(tabId) {
  await ensureSplitSessionsLoaded();
  const normalizedTabId = normalizeTabId(tabId);
  if (!Number.isInteger(normalizedTabId)) return;

  const session = splitSessionsByTab.get(normalizedTabId);
  if (!session) return;

  const remainingTabId = normalizedTabId === session.sourceTabId ? session.targetTabId : session.sourceTabId;
  await clearSplitSession(normalizedTabId, { notifyTabs: false });
  if (Number.isInteger(remainingTabId)) {
    await chrome.tabs.sendMessage(remainingTabId, { type: "CLEAR_TRANSLATIONS" }).catch(() => {});
  }
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
  const safe = sanitizeOptions(options);
  const allowedViewModes = new Set(["inline", "split"]);
  const allowedDisplayModes = new Set(["below", "replace"]);
  const allowedScopes = new Set(["viewport", "page"]);

  safe.viewMode = allowedViewModes.has(options.viewMode) ? options.viewMode : "split";
  safe.displayMode = allowedDisplayModes.has(options.displayMode) ? options.displayMode : "replace";
  safe.translateScope = allowedScopes.has(options.translateScope) ? options.translateScope : DEFAULT_SETTINGS.translateScope;
  if (typeof options.skipTranslated === "boolean") safe.skipTranslated = options.skipTranslated;
  if (Number.isFinite(Number(options.batchSize))) safe.batchSize = clamp(Number(options.batchSize), 1, 20);
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
  const keys = [
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
    "percent"
  ];
  const parts = [];

  keys.forEach((key) => {
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
  const volatileKeys = new Set([
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
  const safe = {};

  Object.keys(value || {}).sort().forEach((key) => {
    if (volatileKeys.has(key)) return;
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
  const secretKeys = Object.keys(SECRET_DEFAULTS);
  const legacy = await chrome.storage.sync.get(secretKeys);
  const nextSecrets = Object.fromEntries(
    Object.entries(legacy).filter(([, value]) => typeof value === "string" && value.length > 0)
  );

  if (Object.keys(nextSecrets).length > 0) {
    await chrome.storage.local.set(nextSecrets);
  }
  await chrome.storage.sync.remove(secretKeys);
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
    await recordTranslationLog({
      ...requestMeta,
      status: "error",
      durationMs: Date.now() - startedAt,
      error: sanitizeError(error)
    }, settings);
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
      return translateWithOpenAICompatible(texts, {
        ...settings,
        openaiEndpoint: settings.zhipuEndpoint,
        openaiApiKey: settings.zhipuApiKey,
        openaiModel: settings.zhipuModel,
        providerLabel: "Zhipu BigModel"
      });
    case "gpt":
      return translateWithOpenAICompatible(texts, {
        ...settings,
        openaiEndpoint: settings.gptEndpoint,
        openaiApiKey: settings.gptApiKey,
        openaiModel: settings.gptModel,
        providerLabel: "GPT / OpenAI"
      });
    case "gemini":
      return translateWithGemini(texts, settings);
    case "claude":
      return translateWithClaude(texts, settings);
    case "openai":
      return translateWithOpenAICompatible(texts, {
        ...settings,
        providerLabel: "OpenAI-compatible"
      });
    case "mymemory":
    default:
      return translateWithMyMemory(texts, settings);
  }
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
  switch (settings.provider) {
    case "zhipu":
      return settings.zhipuModel;
    case "gpt":
      return settings.gptModel;
    case "gemini":
      return settings.geminiModel;
    case "claude":
      return settings.claudeModel;
    case "openai":
      return settings.openaiModel;
    case "microsoft":
      return "Microsoft Translator";
    case "google":
      return "Google Translate";
    case "mymemory":
    default:
      return "MyMemory";
  }
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
  const allowedProviders = new Set(["google", "microsoft", "zhipu", "gpt", "gemini", "claude", "openai", "mymemory"]);
  const allowedLangs = new Set(["auto", "ko", "en", "ja", "zh-CN", "zh-TW", "es", "fr", "de"]);
  const allowedModels = {
    zhipuModel: new Set(["glm-4-flash", "glm-4-air", "glm-4-plus"]),
    gptModel: new Set(["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"]),
    geminiModel: new Set(["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"]),
    claudeModel: new Set(["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest"])
  };
  const safe = {};

  if (allowedProviders.has(options.provider)) safe.provider = options.provider;
  if (allowedLangs.has(options.targetLang)) safe.targetLang = options.targetLang;
  if (allowedLangs.has(options.sourceLang)) safe.sourceLang = options.sourceLang;
  for (const [key, values] of Object.entries(allowedModels)) {
    if (values.has(options[key])) safe[key] = options[key];
  }
  if (typeof options.microsoftRegion === "string" && /^[a-z0-9-]{0,32}$/i.test(options.microsoftRegion)) {
    safe.microsoftRegion = options.microsoftRegion;
  }
  if (typeof options.openaiEndpoint === "string" && isAllowedOpenAICompatibleEndpoint(options.openaiEndpoint)) {
    safe.openaiEndpoint = options.openaiEndpoint;
  }
  if (typeof options.openaiModel === "string" && /^[A-Za-z0-9._:/-]{1,80}$/.test(options.openaiModel)) {
    safe.openaiModel = options.openaiModel;
  }
  if (typeof options.keepTextLogs === "boolean") safe.keepTextLogs = options.keepTextLogs;

  return safe;
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

async function translateWithGoogle(texts, settings) {
  const source = settings.sourceLang === "auto" ? "auto" : normalizeGoogleLang(settings.sourceLang);
  const target = normalizeGoogleLang(settings.targetLang);
  const translations = [];

  for (const text of texts) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", source);
    url.searchParams.set("tl", target);
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", text);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Google Translate request failed: ${response.status}`);
    }

    const payload = await response.json();
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
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", text);
    url.searchParams.set("langpair", `${source}|${target}`);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`MyMemory request failed: ${response.status}`);
    }

    const payload = await response.json();
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

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(texts.map((text) => ({ Text: text })))
  });

  if (!response.ok) {
    throw new Error(`Microsoft Translator request failed: ${response.status}`);
  }

  const payload = await response.json();
  return {
    translations: payload.map((item) => cleanTranslation(item?.translations?.[0]?.text || ""))
  };
}

async function translateWithOpenAICompatible(texts, settings) {
  if (!settings.openaiApiKey) {
    throw new Error(`${settings.providerLabel || "OpenAI-compatible"} API key is missing. Set it in extension options.`);
  }

  const response = await fetch(settings.openaiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "Translate each input string faithfully. Preserve meaning, names, numbers, punctuation, and inline whitespace. Return only a JSON array of translated strings."
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
    })
  });

  if (!response.ok) {
    throw new Error(`${settings.providerLabel || "OpenAI-compatible"} request failed: ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseJsonArray(content);
  if (!parsed || parsed.length !== texts.length) {
    throw new Error("Translation response was not a JSON array with the expected length.");
  }

  return {
    translations: parsed.map((item) => cleanTranslation(String(item || ""))),
    usage: normalizeOpenAIUsage(payload?.usage)
  };
}

async function translateWithGemini(texts, settings) {
  if (!settings.geminiApiKey) {
    throw new Error("Gemini API key is missing. Set it in extension options.");
  }

  const endpoint = `${settings.geminiEndpoint.replace(/\/$/, "")}/models/${encodeURIComponent(settings.geminiModel)}:generateContent`;
  const response = await fetch(endpoint, {
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
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }

  const payload = await response.json();
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

  const response = await fetch(settings.claudeEndpoint, {
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
      system:
        "Translate faithfully. Preserve meaning, names, numbers, punctuation, and inline whitespace. Return only a JSON array of translated strings.",
      messages: [
        {
          role: "user",
          content: buildTranslationPrompt(settings.targetLang, settings.sourceLang, texts)
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Claude request failed: ${response.status}`);
  }

  const payload = await response.json();
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

function parseJsonArray(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function parseTranslations(content, expectedLength) {
  const parsed = parseJsonArray(content);
  if (!parsed || parsed.length !== expectedLength) {
    throw new Error("Translation response was not a JSON array with the expected length.");
  }

  return parsed.map((item) => cleanTranslation(String(item || "")));
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
