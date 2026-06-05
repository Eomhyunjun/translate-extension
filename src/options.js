const DEFAULT_SETTINGS = globalThis.BIT_DEFAULT_SETTINGS;
const SECRET_DEFAULTS = globalThis.BIT_SECRET_DEFAULTS;
const SECRET_SETTING_KEYS = globalThis.BIT_SECRET_SETTING_KEYS;

const settingsTab = document.querySelector("#settingsTab");
const keysTab = document.querySelector("#keysTab");
const logsTab = document.querySelector("#logsTab");
const settingsPanel = document.querySelector("#settingsPanel");
const keysPanel = document.querySelector("#keysPanel");
const logsPanel = document.querySelector("#logsPanel");
const message = document.querySelector("#message");

const provider = document.querySelector("#provider");
const providerFields = document.querySelector("#providerFields");
const microsoftRegion = document.querySelector("#microsoftRegion");
const zhipuModel = document.querySelector("#zhipuModel");
const gptModel = document.querySelector("#gptModel");
const geminiModel = document.querySelector("#geminiModel");
const claudeModel = document.querySelector("#claudeModel");
const solarModel = document.querySelector("#solarModel");
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
const batchHelpBtn = document.querySelector("#batchHelpBtn");
const batchHelp = document.querySelector("#batchHelp");
const saveSettingsBtn = document.querySelector("#saveSettingsBtn");
const resetSettingsBtn = document.querySelector("#resetSettingsBtn");

const microsoftApiKey = document.querySelector("#microsoftApiKey");
const zhipuApiKey = document.querySelector("#zhipuApiKey");
const gptApiKey = document.querySelector("#gptApiKey");
const geminiApiKey = document.querySelector("#geminiApiKey");
const claudeApiKey = document.querySelector("#claudeApiKey");
const solarApiKey = document.querySelector("#solarApiKey");
const openaiApiKey = document.querySelector("#openaiApiKey");
const keepTextLogs = document.querySelector("#keepTextLogs");
const logsList = document.querySelector("#logsList");
const logSummary = document.querySelector("#logSummary");
const saveBtn = document.querySelector("#saveBtn");
const resetBtn = document.querySelector("#resetBtn");
const clearLogsBtn = document.querySelector("#clearLogsBtn");

const TAB_CONTROLS = Object.freeze({
  settings: { tab: settingsTab, panel: settingsPanel },
  keys: { tab: keysTab, panel: keysPanel },
  logs: { tab: logsTab, panel: logsPanel }
});

const API_KEY_INPUTS = Object.freeze({
  microsoftApiKey,
  zhipuApiKey,
  gptApiKey,
  geminiApiKey,
  claudeApiKey,
  solarApiKey,
  openaiApiKey
});

const SETTINGS_MESSAGES = Object.freeze({
  initFailed: "초기화에 실패했습니다.",
  saveFailed: "설정 저장에 실패했습니다.",
  saved: "번역 설정을 저장했습니다. 이제 확장 아이콘 클릭으로 바로 적용됩니다.",
  reset: "번역 설정을 기본값으로 되돌렸습니다.",
  invalidCompatibleEndpoint: "OpenAI-compatible endpoint는 HTTPS URL이어야 하며 /chat/completions로 끝나야 합니다.",
  compatibleEndpointDenied: "OpenAI-compatible endpoint 권한이 승인되지 않아 저장하지 않았습니다."
});

init().catch((error) => setMessage(error.message || SETTINGS_MESSAGES.initFailed));

settingsTab.addEventListener("click", () => selectTab("settings"));
keysTab.addEventListener("click", () => selectTab("keys"));
logsTab.addEventListener("click", () => selectTab("logs"));
saveSettingsBtn.addEventListener("click", () => runAction(savePublicSettings));
resetSettingsBtn.addEventListener("click", () => runAction(resetPublicSettings));
saveBtn.addEventListener("click", () => runAction(saveKeys));
resetBtn.addEventListener("click", () => runAction(resetKeys));
clearLogsBtn.addEventListener("click", () => runAction(clearLogs));
keepTextLogs.addEventListener("change", () => runAction(saveLogSetting));
provider.addEventListener("change", syncProviderFields);
viewMode.addEventListener("change", syncViewModeFields);
batchHelpBtn.addEventListener("click", toggleBatchHelp);

async function init() {
  await migrateSecretsToLocal();
  const [secrets, settings] = await Promise.all([
    chrome.storage.local.get(SECRET_DEFAULTS),
    chrome.storage.sync.get(DEFAULT_SETTINGS)
  ]);

  fillPublicSettings(settings);
  fillSecrets(secrets);
  keepTextLogs.checked = Boolean(settings.keepTextLogs);
  await renderLogs();
}

async function migrateSecretsToLocal() {
  const legacy = await chrome.storage.sync.get(SECRET_DEFAULTS);
  const nextSecrets = Object.fromEntries(
    Object.entries(legacy).filter(([, value]) => typeof value === "string" && value.length > 0)
  );
  const legacyKeys = SECRET_SETTING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(legacy, key));

  if (Object.keys(nextSecrets).length > 0) {
    await chrome.storage.local.set(nextSecrets);
  }
  if (legacyKeys.length > 0) {
    await chrome.storage.sync.remove(legacyKeys);
  }
}

function fillPublicSettings(settings) {
  provider.value = settings.provider || DEFAULT_SETTINGS.provider;
  microsoftRegion.value = settings.microsoftRegion || DEFAULT_SETTINGS.microsoftRegion;
  zhipuModel.value = settings.zhipuModel || DEFAULT_SETTINGS.zhipuModel;
  gptModel.value = settings.gptModel || DEFAULT_SETTINGS.gptModel;
  geminiModel.value = settings.geminiModel || DEFAULT_SETTINGS.geminiModel;
  claudeModel.value = settings.claudeModel || DEFAULT_SETTINGS.claudeModel;
  solarModel.value = settings.solarModel || DEFAULT_SETTINGS.solarModel;
  openaiEndpoint.value = settings.openaiEndpoint || DEFAULT_SETTINGS.openaiEndpoint;
  openaiModel.value = settings.openaiModel || DEFAULT_SETTINGS.openaiModel;
  sourceLang.value = settings.sourceLang || DEFAULT_SETTINGS.sourceLang;
  targetLang.value = settings.targetLang || DEFAULT_SETTINGS.targetLang;
  viewMode.value = normalizeViewMode(settings.viewMode);
  displayMode.value = settings.displayMode || DEFAULT_SETTINGS.displayMode;
  translateScope.value = settings.translateScope || DEFAULT_SETTINGS.translateScope;
  skipTranslated.checked = settings.skipTranslated !== false;
  batchSize.value = clamp(Number(settings.batchSize) || DEFAULT_SETTINGS.batchSize, 1, 20);
  syncProviderFields();
  syncViewModeFields();
}

function fillSecrets(secrets) {
  Object.entries(API_KEY_INPUTS).forEach(([key, input]) => {
    input.value = secrets[key] || SECRET_DEFAULTS[key];
  });
}

function readPublicSettings() {
  return {
    provider: provider.value,
    microsoftRegion: microsoftRegion.value.trim(),
    zhipuModel: zhipuModel.value,
    gptModel: gptModel.value,
    geminiModel: geminiModel.value,
    claudeModel: claudeModel.value,
    solarModel: solarModel.value,
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

function readSecrets() {
  return Object.fromEntries(
    Object.entries(API_KEY_INPUTS).map(([key, input]) => [key, input.value.trim()])
  );
}

async function savePublicSettings() {
  const nextSettings = readPublicSettings();
  await ensureEndpointPermission(nextSettings);
  await chrome.storage.sync.set(nextSettings);
  setMessage(SETTINGS_MESSAGES.saved);
}

async function resetPublicSettings() {
  const defaults = readPublicDefaults();
  await chrome.storage.sync.set(defaults);
  fillPublicSettings(DEFAULT_SETTINGS);
  setMessage(SETTINGS_MESSAGES.reset);
}

function readPublicDefaults() {
  const { keepTextLogs: _keepTextLogs, ...publicDefaults } = DEFAULT_SETTINGS;
  return publicDefaults;
}

async function saveKeys() {
  await Promise.all([
    chrome.storage.local.set(readSecrets()),
    chrome.storage.sync.remove(SECRET_SETTING_KEYS)
  ]);
  setMessage("API 키를 저장했습니다.");
}

async function resetKeys() {
  await Promise.all([
    chrome.storage.local.remove(SECRET_SETTING_KEYS),
    chrome.storage.sync.remove(SECRET_SETTING_KEYS)
  ]);
  fillSecrets(SECRET_DEFAULTS);
  setMessage("API 키를 삭제했습니다.");
}

async function saveLogSetting() {
  await chrome.storage.sync.set({ keepTextLogs: keepTextLogs.checked });
  setMessage(keepTextLogs.checked ? "로그 저장을 켰습니다." : "로그 저장을 껐습니다.");
}

async function clearLogs() {
  await chrome.storage.local.set({ translationLogs: [] });
  await renderLogs();
  setMessage("사용 로그를 삭제했습니다.");
}

async function renderLogs() {
  const { translationLogs = [] } = await chrome.storage.local.get({ translationLogs: [] });
  const logs = Array.isArray(translationLogs) ? translationLogs : [];
  const totalInput = logs.reduce((sum, log) => sum + (log.usage?.inputTokens ?? log.inputEstimatedTokens ?? 0), 0);
  const totalOutput = logs.reduce((sum, log) => sum + (log.usage?.outputTokens ?? log.outputEstimatedTokens ?? 0), 0);

  logSummary.textContent = logs.length
    ? `${logs.length}개 요청 배치 | 입력 ${totalInput.toLocaleString()} tokens | 출력 ${totalOutput.toLocaleString()} tokens`
    : "저장된 사용 로그가 없습니다.";

  logsList.replaceChildren(...logs.map(renderLogItem));
}

function renderLogItem(log) {
  const item = document.createElement("article");
  item.className = `log-item ${log.status === "error" ? "error" : ""}`;

  const title = document.createElement("div");
  title.className = "log-title";
  title.textContent = `${formatDate(log.createdAt)} · ${log.provider} · ${log.model}`;

  const metrics = document.createElement("div");
  metrics.className = "log-metrics";
  metrics.textContent = [
    `${log.textCount} texts`,
    `${log.inputCharCount} chars`,
    `in ${formatTokens(log.usage?.inputTokens, log.inputEstimatedTokens)}`,
    `out ${formatTokens(log.usage?.outputTokens, log.outputEstimatedTokens)}`,
    `${log.durationMs ?? 0}ms`,
    log.status
  ].join(" · ");

  item.append(title, metrics);

  if (log.error) {
    const error = document.createElement("p");
    error.className = "log-error";
    error.textContent = log.error;
    item.append(error);
  }

  item.append(
    renderPreview("보낸 텍스트 미리보기", log.previews || []),
    renderPreview("출력 텍스트 미리보기", log.outputPreviews || [])
  );

  return item;
}

function renderPreview(label, values) {
  const preview = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  const text = document.createElement("pre");
  text.textContent = values.length ? values.join("\n\n") : "저장된 미리보기가 없습니다.";
  preview.append(summary, text);
  return preview;
}

function syncProviderFields() {
  const activeProvider = provider.value;
  let visibleCount = 0;

  document.querySelectorAll(".provider-field").forEach((field) => {
    const isVisible = field.dataset.providerField === activeProvider;
    field.hidden = !isVisible;
    field.setAttribute("aria-hidden", String(!isVisible));
    field.querySelectorAll("input, select, textarea, button").forEach((control) => {
      control.disabled = !isVisible;
    });
    if (isVisible) visibleCount += 1;
  });

  providerFields.hidden = visibleCount === 0;
  providerFields.setAttribute("aria-hidden", String(visibleCount === 0));
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

function toggleBatchHelp() {
  const nextExpanded = batchHelp.hidden;
  batchHelp.hidden = !nextExpanded;
  batchHelpBtn.setAttribute("aria-expanded", String(nextExpanded));
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
    throw new Error(SETTINGS_MESSAGES.compatibleEndpointDenied);
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
    throw new Error(SETTINGS_MESSAGES.invalidCompatibleEndpoint);
  }
}

function selectTab(activeTab) {
  Object.entries(TAB_CONTROLS).forEach(([name, controls]) => {
    const isActive = name === activeTab;
    controls.tab.classList.toggle("active", isActive);
    controls.tab.setAttribute("aria-selected", String(isActive));
    controls.panel.hidden = !isActive;
  });

  if (activeTab === "logs") {
    renderLogs().catch((error) => setMessage(error.message || "사용 로그를 불러오지 못했습니다."));
  }
}

function normalizeViewMode(value) {
  if (value === "panel" || value === "split") return "split";
  return "inline";
}

function formatTokens(actual, estimated) {
  if (actual != null) return `${actual.toLocaleString()} tokens`;
  return `~${Number(estimated || 0).toLocaleString()} tokens`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function setMessage(text) {
  message.textContent = text;
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    setMessage(error.message || SETTINGS_MESSAGES.saveFailed);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
