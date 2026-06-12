const DEFAULT_SETTINGS = globalThis.BIT_DEFAULT_SETTINGS;
const SECRET_DEFAULTS = globalThis.BIT_SECRET_DEFAULTS;

const provider = document.querySelector("#provider");
const providerFields = document.querySelector("#providerFields");
const zhipuModel = document.querySelector("#zhipuModel");
const gptModel = document.querySelector("#gptModel");
const geminiModel = document.querySelector("#geminiModel");
const claudeModel = document.querySelector("#claudeModel");
const solarModel = document.querySelector("#solarModel");
const openaiModel = document.querySelector("#openaiModel");
const sourceLang = document.querySelector("#sourceLang");
const targetLang = document.querySelector("#targetLang");
const inlineBtn = document.querySelector("#inlineBtn");
const splitBtn = document.querySelector("#splitBtn");
const clearBtn = document.querySelector("#clearBtn");
const openSettingsBtn = document.querySelector("#openSettingsBtn");
const apiKeyNotice = document.querySelector("#apiKeyNotice");
const apiKeyNoticeText = document.querySelector("#apiKeyNoticeText");
const setupKeyBtn = document.querySelector("#setupKeyBtn");
const message = document.querySelector("#message");

const POPUP_MESSAGES = Object.freeze({
  initFailed: "초기화에 실패했습니다.",
  saveFailed: "설정 저장에 실패했습니다.",
  pageUnavailable: "현재 페이지에서 실행할 수 없습니다.",
  translateBusy: "번역 중...",
  clearBusy: "번역 제거 중...",
  tabScriptUnavailable: "현재 탭에 확장 스크립트를 주입할 수 없습니다. 일반 웹페이지에서 다시 시도하세요.",
  invalidCompatibleEndpoint: "OpenAI-compatible endpoint는 HTTPS URL이어야 하며 /chat/completions로 끝나야 합니다.",
  compatibleEndpointDenied: "OpenAI-compatible endpoint 권한이 승인되지 않아 저장하지 않았습니다."
});

const PROVIDER_API_KEY_NAMES = Object.freeze({
  microsoft: "microsoftApiKey",
  zhipu: "zhipuApiKey",
  gpt: "gptApiKey",
  gemini: "geminiApiKey",
  claude: "claudeApiKey",
  solar: "solarApiKey",
  openai: "openaiApiKey"
});

let providerKeyPresence = {};

init().catch((error) => setMessage(error.message || POPUP_MESSAGES.initFailed));

provider.addEventListener("change", () => {
  syncProviderFields();
  syncProviderAvailability();
  savePopupSettings().catch((error) => setMessage(error.message || POPUP_MESSAGES.saveFailed));
});

document.querySelectorAll("select, input").forEach((control) => {
  if (control === provider) return;
  control.addEventListener("change", () => {
    savePopupSettings().catch((error) => setMessage(error.message || POPUP_MESSAGES.saveFailed));
  });
});

inlineBtn.addEventListener("click", () => runPopupAction(POPUP_MESSAGES.translateBusy, () => applyTranslation("inline")));
splitBtn.addEventListener("click", () => runPopupAction(POPUP_MESSAGES.translateBusy, () => applyTranslation("split")));
clearBtn.addEventListener("click", () => runPopupAction(POPUP_MESSAGES.clearBusy, clearCurrentTabTranslations));
openSettingsBtn.addEventListener("click", openSettingsPage);
setupKeyBtn.addEventListener("click", openSettingsPage);

async function init() {
  const [settings, secrets] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get(SECRET_DEFAULTS)
  ]);
  providerKeyPresence = computeKeyPresence(secrets);
  fill(settings);
  syncProviderAvailability();
}

function fill(settings) {
  provider.value = settings.provider || DEFAULT_SETTINGS.provider;
  zhipuModel.value = settings.zhipuModel || DEFAULT_SETTINGS.zhipuModel;
  gptModel.value = settings.gptModel || DEFAULT_SETTINGS.gptModel;
  geminiModel.value = settings.geminiModel || DEFAULT_SETTINGS.geminiModel;
  claudeModel.value = settings.claudeModel || DEFAULT_SETTINGS.claudeModel;
  solarModel.value = settings.solarModel || DEFAULT_SETTINGS.solarModel;
  openaiModel.value = settings.openaiModel || DEFAULT_SETTINGS.openaiModel;
  sourceLang.value = settings.sourceLang || DEFAULT_SETTINGS.sourceLang;
  targetLang.value = settings.targetLang || DEFAULT_SETTINGS.targetLang;
  syncProviderFields();
}

function syncProviderFields() {
  const activeProvider = provider.value;
  let visibleCount = 0;

  document.querySelectorAll(".provider-field").forEach((field) => {
    const isVisible = field.dataset.providerField === activeProvider;
    field.hidden = !isVisible;
    field.setAttribute("aria-hidden", String(!isVisible));
    field.querySelectorAll("input, select").forEach((control) => {
      control.disabled = !isVisible;
    });
    if (isVisible) visibleCount += 1;
  });

  providerFields.hidden = visibleCount === 0;
  providerFields.setAttribute("aria-hidden", String(visibleCount === 0));
}

function syncProviderAvailability() {
  syncProviderOptionStates();

  const needsSetup = providerNeedsSetup(provider.value);
  inlineBtn.disabled = needsSetup;
  splitBtn.disabled = needsSetup;
  apiKeyNotice.hidden = !needsSetup;
  if (needsSetup) {
    apiKeyNoticeText.textContent =
      `${providerLabel(provider.value)} 엔진은 API 키가 필요합니다. 상세 설정에서 키를 입력한 뒤 사용할 수 있어요.`;
  }
}

function syncProviderOptionStates() {
  Array.from(provider.options).forEach((option) => {
    if (option.dataset.baseLabel === undefined) {
      option.dataset.baseLabel = option.textContent;
    }
    const needsSetup = providerNeedsSetup(option.value);
    option.disabled = needsSetup;
    option.textContent = needsSetup ? `${option.dataset.baseLabel} (키 필요)` : option.dataset.baseLabel;
  });
}

function providerNeedsSetup(providerName) {
  if (!(providerName in PROVIDER_API_KEY_NAMES)) return false;
  return providerKeyPresence[providerName] !== true;
}

function providerLabel(providerName) {
  const option = Array.from(provider.options).find((item) => item.value === providerName);
  return option?.dataset.baseLabel || option?.textContent || providerName;
}

function computeKeyPresence(secrets) {
  const presence = {};
  for (const [providerName, keyName] of Object.entries(PROVIDER_API_KEY_NAMES)) {
    const value = secrets?.[keyName];
    presence[providerName] = typeof value === "string" && value.trim().length > 0;
  }
  return presence;
}

function openSettingsPage() {
  chrome.runtime.openOptionsPage();
  window.close();
}

function readPopupSettings() {
  return {
    provider: provider.value,
    zhipuModel: zhipuModel.value,
    gptModel: gptModel.value,
    geminiModel: geminiModel.value,
    claudeModel: claudeModel.value,
    solarModel: solarModel.value,
    openaiModel: openaiModel.value.trim() || DEFAULT_SETTINGS.openaiModel,
    sourceLang: sourceLang.value,
    targetLang: targetLang.value
  };
}

async function savePopupSettings() {
  const nextSettings = readPopupSettings();
  await ensureEndpointPermission(nextSettings);
  await chrome.storage.sync.set(nextSettings);
}

async function applyTranslation(viewMode) {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const popupSettings = readPopupSettings();
  const options = {
    ...DEFAULT_SETTINGS,
    ...stored,
    ...popupSettings,
    viewMode,
    displayMode: viewMode === "inline" ? "below" : "replace",
    translateScope: "viewport",
    enabled: true
  };

  await ensureEndpointPermission(options);
  await chrome.storage.sync.set(popupSettings);

  const tab = await getActiveTab();
  if (viewMode === "split") {
    const response = await sendTabMessage(tab.id, {
      type: "START_IN_PAGE_SPLIT",
      options
    });
    requireOkResponse(response, "분할 번역을 시작하지 못했습니다.");
    setMessage("같은 탭 분할 보기를 열었습니다.");
    return;
  }

  const response = await sendTabMessage(tab.id, {
    type: "TRANSLATE_PAGE",
    options
  });
  requireOkResponse(response, "번역을 완료하지 못했습니다.");
  const translatedCount = Number(response.translatedCount) || 0;
  const failedCount = Number(response.failedCount) || 0;
  setMessage(
    failedCount > 0
      ? `${translatedCount}개 문단을 번역했고 ${failedCount}개는 실패했습니다.`
      : `${translatedCount}개 문단을 번역했습니다.`
  );
}

async function clearCurrentTabTranslations() {
  const tab = await getActiveTab();
  await sendTabMessage(tab.id, { type: "CLEAR_TRANSLATIONS" }).catch(() => {});
  setMessage("번역을 제거했습니다.");
}

async function runPopupAction(busyMessage, action) {
  setBusy(true, busyMessage);
  try {
    await action();
  } catch (error) {
    setMessage(error.message || POPUP_MESSAGES.pageUnavailable);
  } finally {
    setBusy(false);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("활성 탭을 찾을 수 없습니다.");
  return tab;
}

async function sendTabMessage(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!isTransientExtensionError(error)) throw error;
  }

  await injectContentScript(tabId);

  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (isTransientExtensionError(error)) throw new Error(POPUP_MESSAGES.tabScriptUnavailable);
    throw error;
  }
}

function requireOkResponse(response, fallbackMessage) {
  if (response?.ok) return;
  throw new Error(response?.error || fallbackMessage);
}

function setBusy(isBusy, text = "") {
  inlineBtn.disabled = isBusy;
  splitBtn.disabled = isBusy;
  clearBtn.disabled = isBusy;
  if (text) setMessage(text);
  if (!isBusy) syncProviderAvailability();
}

function setMessage(text) {
  message.textContent = text;
}

function isTransientExtensionError(error) {
  const text = error?.message || String(error || "");
  return (
    text.includes("Extension context invalidated") ||
    text.includes("Receiving end does not exist") ||
    text.includes("message channel closed") ||
    text.includes("message port closed")
  );
}

async function injectContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedPageUrl(tab?.url)) {
    throw new Error(POPUP_MESSAGES.pageUnavailable);
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/defaults.js", "src/content.js"]
    });
  } catch (error) {
    throw new Error(error?.message || POPUP_MESSAGES.tabScriptUnavailable);
  }
}

function isSupportedPageUrl(url) {
  return /^(https?|file):\/\//i.test(String(url || ""));
}

async function ensureEndpointPermission(nextSettings) {
  if (nextSettings.provider !== "openai") return;

  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const endpoint = stored.openaiEndpoint || DEFAULT_SETTINGS.openaiEndpoint;
  const url = parseOpenAICompatibleEndpoint(endpoint);
  if (url.hostname === "api.openai.com") return;

  const origin = `${url.origin}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) return;

  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(POPUP_MESSAGES.compatibleEndpointDenied);
  }
}

function parseOpenAICompatibleEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.pathname.endsWith("/chat/completions")) {
      throw new Error();
    }
    return url;
  } catch {
    throw new Error(POPUP_MESSAGES.invalidCompatibleEndpoint);
  }
}
