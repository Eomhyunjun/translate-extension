const DEFAULT_SETTINGS = globalThis.BIT_DEFAULT_SETTINGS;

const provider = document.querySelector("#provider");
const microsoftRegion = document.querySelector("#microsoftRegion");
const zhipuModel = document.querySelector("#zhipuModel");
const gptModel = document.querySelector("#gptModel");
const geminiModel = document.querySelector("#geminiModel");
const claudeModel = document.querySelector("#claudeModel");
const openaiEndpoint = document.querySelector("#openaiEndpoint");
const openaiModel = document.querySelector("#openaiModel");
const sourceLang = document.querySelector("#sourceLang");
const targetLang = document.querySelector("#targetLang");
const viewMode = document.querySelector("#viewMode");
const displayMode = document.querySelector("#displayMode");
const displayModeField = document.querySelector("#displayModeField");
const translateScope = document.querySelector("#translateScope");
const translateScopeField = document.querySelector("#translateScopeField");
const skipTranslated = document.querySelector("#skipTranslated");
const batchSize = document.querySelector("#batchSize");
const translateBtn = document.querySelector("#translateBtn");
const clearBtn = document.querySelector("#clearBtn");
const optionsBtn = document.querySelector("#optionsBtn");
const batchHelpBtn = document.querySelector("#batchHelpBtn");
const batchHelp = document.querySelector("#batchHelp");
const message = document.querySelector("#message");
const statusDot = document.querySelector("#statusDot");

const POPUP_MESSAGES = Object.freeze({
  initFailed: "초기화에 실패했습니다.",
  saveFailed: "설정 저장에 실패했습니다.",
  pageUnavailable: "현재 페이지에서 실행할 수 없습니다.",
  translateBusy: "번역 적용 중...",
  clearBusy: "번역 제거 중...",
  translateFailed: "번역을 완료하지 못했습니다.",
  tabScriptMissing: "현재 탭에 확장 스크립트가 준비되지 않았습니다. 페이지를 새로고침한 뒤 다시 시도하세요.",
  splitClearFailed: "분할 보기 세션을 초기화하지 못했습니다.",
  invalidCompatibleEndpoint: "OpenAI-compatible endpoint는 HTTPS URL이어야 하며 /chat/completions로 끝나야 합니다.",
  compatibleEndpointDenied: "OpenAI-compatible endpoint 권한이 승인되지 않아 저장하지 않았습니다."
});

const TRANSLATION_RESULT_SUFFIX = Object.freeze({
  inline: "스크롤하면 이어서 번역합니다.",
  split: "분할 보기에서 표시합니다."
});

init().catch((error) => setMessage(error.message || POPUP_MESSAGES.initFailed));

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  fill(settings);
  bindAutoSave();
  refreshStatus();
}

function fill(settings) {
  provider.value = settings.provider;
  microsoftRegion.value = settings.microsoftRegion;
  zhipuModel.value = settings.zhipuModel;
  gptModel.value = settings.gptModel;
  geminiModel.value = settings.geminiModel;
  claudeModel.value = settings.claudeModel;
  openaiEndpoint.value = settings.openaiEndpoint;
  openaiModel.value = settings.openaiModel;
  sourceLang.value = settings.sourceLang;
  targetLang.value = settings.targetLang;
  viewMode.value = normalizeViewMode(settings.viewMode);
  displayMode.value = settings.displayMode;
  translateScope.value = settings.translateScope;
  skipTranslated.checked = Boolean(settings.skipTranslated);
  batchSize.value = settings.batchSize;
  syncProviderFields();
  syncViewModeFields();
}

function bindAutoSave() {
  document.querySelectorAll("select, input").forEach((control) => {
    control.addEventListener("change", () => {
      savePublicSettings().catch((error) => setMessage(error.message || POPUP_MESSAGES.saveFailed));
    });
  });
  provider.addEventListener("change", syncProviderFields);
  viewMode.addEventListener("change", syncViewModeFields);
}

translateBtn.addEventListener("click", () => runPopupAction(POPUP_MESSAGES.translateBusy, applyTranslation));
clearBtn.addEventListener("click", () => runPopupAction(POPUP_MESSAGES.clearBusy, clearCurrentTabTranslations));

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

batchHelpBtn.addEventListener("click", () => {
  const nextExpanded = batchHelp.hidden;
  batchHelp.hidden = !nextExpanded;
  batchHelpBtn.setAttribute("aria-expanded", String(nextExpanded));
});

async function savePublicSettings() {
  const nextSettings = readPublicSettings();
  await ensureEndpointPermission(nextSettings);
  await chrome.storage.sync.set(nextSettings);
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

async function applyTranslation() {
  const publicSettings = readPublicSettings();
  await ensureEndpointPermission(publicSettings);
  await chrome.storage.sync.set(publicSettings);

  const tab = await getActiveTab();
  const response = await requestTranslation(tab, publicSettings);
  requireOkResponse(response, POPUP_MESSAGES.translateFailed);

  const translatedCount = Number(response.translatedCount) || 0;
  const suffix = TRANSLATION_RESULT_SUFFIX[publicSettings.viewMode] || TRANSLATION_RESULT_SUFFIX.inline;
  setMessage(`${translatedCount}개 문단 번역 완료. ${suffix}`);
  refreshStatus();
}

async function clearCurrentTabTranslations() {
  const tab = await getActiveTab();
  let clearError = null;

  try {
    await sendTabMessage(tab.id, { type: "CLEAR_TRANSLATIONS" });
  } catch (error) {
    clearError = error;
  }

  await clearSplitSession(tab.id);
  if (clearError) throw clearError;

  setMessage("번역을 제거했습니다.");
  refreshStatus();
}

function readPublicSettings() {
  return {
    provider: provider.value,
    microsoftRegion: microsoftRegion.value.trim(),
    zhipuModel: zhipuModel.value,
    gptModel: gptModel.value,
    geminiModel: geminiModel.value,
    claudeModel: claudeModel.value,
    openaiEndpoint: openaiEndpoint.value.trim() || DEFAULT_SETTINGS.openaiEndpoint,
    openaiModel: openaiModel.value.trim() || DEFAULT_SETTINGS.openaiModel,
    sourceLang: sourceLang.value,
    targetLang: targetLang.value,
    viewMode: normalizeViewMode(viewMode.value),
    displayMode: displayMode.value,
    translateScope: translateScope.value,
    skipTranslated: skipTranslated.checked,
    batchSize: clamp(Number(batchSize.value) || DEFAULT_SETTINGS.batchSize, 1, 20)
  };
}

function syncViewModeFields() {
  const isSplit = normalizeViewMode(viewMode.value) === "split";
  [displayMode, translateScope].forEach((control) => {
    control.disabled = isSplit;
  });
  [displayModeField, translateScopeField].forEach((field) => {
    field.classList.toggle("disabled", isSplit);
  });
}

function syncProviderFields() {
  const activeProvider = provider.value;
  const fields = Array.from(document.querySelectorAll(".provider-field"));
  let visibleCount = 0;

  fields.forEach((field) => {
    const isVisible = field.dataset.providerField === activeProvider;
    field.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  });

  document.querySelector("#providerFields").hidden = visibleCount === 0;
}

async function refreshStatus() {
  try {
    const tab = await getActiveTab();
    const response = await sendTabMessage(tab.id, { type: "GET_PAGE_STATUS" }, { optional: true });
    const active = Boolean(response?.translatedCount);
    statusDot.classList.toggle("active", active);
    statusDot.title = active ? `${response.translatedCount}개 번역 표시 중` : "대기 중";
  } catch {
    statusDot.classList.remove("active");
    statusDot.title = "이 페이지에서는 실행할 수 없습니다.";
  }
}

async function sendTabMessage(tabId, payload, { optional = false } = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (optional || isTransientExtensionError(error)) return null;
    throw new Error(POPUP_MESSAGES.tabScriptMissing);
  }
}

async function sendRuntimeMessage(payload, { optional = false } = {}) {
  try {
    return await chrome.runtime.sendMessage(payload);
  } catch (error) {
    if (optional || isTransientExtensionError(error)) return null;
    throw error;
  }
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

async function requestTranslation(tab, publicSettings) {
  const options = readRuntimeOptions(publicSettings);
  if (publicSettings.viewMode === "split") {
    return sendRuntimeMessage({
      type: "START_SPLIT_MODE",
      tabId: tab.id,
      options
    });
  }

  return sendTabMessage(tab.id, {
    type: "TRANSLATE_PAGE",
    options
  });
}

function requireOkResponse(response, fallbackMessage) {
  if (response?.ok) return;
  throw new Error(response?.error || fallbackMessage);
}

function readRuntimeOptions(publicSettings) {
  const runtimeOptions = { ...publicSettings, enabled: true };
  if (runtimeOptions.viewMode === "split") {
    runtimeOptions.translateScope = "viewport";
  }
  return runtimeOptions;
}

async function clearSplitSession(tabId) {
  const response = await sendRuntimeMessage({ type: "CLEAR_SPLIT_SESSION", tabId }, { optional: true });
  if (response?.ok === false) {
    throw new Error(response.error || POPUP_MESSAGES.splitClearFailed);
  }
}

function normalizeViewMode(value) {
  if (value === "panel" || value === "split") return "split";
  return "inline";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("활성 탭을 찾을 수 없습니다.");
  return tab;
}

function setBusy(isBusy, text = "") {
  translateBtn.disabled = isBusy;
  clearBtn.disabled = isBusy;
  if (text) setMessage(text);
}

function setMessage(text) {
  message.textContent = text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function ensureEndpointPermission(nextSettings) {
  if (nextSettings.provider !== "openai") return;

  const url = parseOpenAICompatibleEndpoint(nextSettings.openaiEndpoint);
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
