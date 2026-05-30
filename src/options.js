const DEFAULT_SETTINGS = globalThis.BIT_DEFAULT_SETTINGS;
const SECRET_DEFAULTS = globalThis.BIT_SECRET_DEFAULTS;
const SECRET_SETTING_KEYS = globalThis.BIT_SECRET_SETTING_KEYS;

const keysTab = document.querySelector("#keysTab");
const logsTab = document.querySelector("#logsTab");
const keysPanel = document.querySelector("#keysPanel");
const logsPanel = document.querySelector("#logsPanel");
const microsoftApiKey = document.querySelector("#microsoftApiKey");
const zhipuApiKey = document.querySelector("#zhipuApiKey");
const gptApiKey = document.querySelector("#gptApiKey");
const geminiApiKey = document.querySelector("#geminiApiKey");
const claudeApiKey = document.querySelector("#claudeApiKey");
const openaiApiKey = document.querySelector("#openaiApiKey");
const keepTextLogs = document.querySelector("#keepTextLogs");
const logsList = document.querySelector("#logsList");
const logSummary = document.querySelector("#logSummary");
const saveBtn = document.querySelector("#saveBtn");
const resetBtn = document.querySelector("#resetBtn");
const clearLogsBtn = document.querySelector("#clearLogsBtn");
const message = document.querySelector("#message");

const LOG_SETTING_DEFAULTS = Object.freeze({
  keepTextLogs: DEFAULT_SETTINGS.keepTextLogs
});

const API_KEY_INPUTS = Object.freeze({
  microsoftApiKey,
  zhipuApiKey,
  gptApiKey,
  geminiApiKey,
  claudeApiKey,
  openaiApiKey
});

init().catch((error) => setMessage(error.message || "초기화에 실패했습니다."));

keysTab.addEventListener("click", () => selectTab("keys"));
logsTab.addEventListener("click", () => selectTab("logs"));
saveBtn.addEventListener("click", () => runAction(save));
resetBtn.addEventListener("click", () => runAction(resetKeys));
clearLogsBtn.addEventListener("click", () => runAction(clearLogs));
keepTextLogs.addEventListener("change", () => runAction(saveLogSetting));

async function init() {
  await migrateSecretsToLocal();
  const [secrets, settings] = await Promise.all([
    chrome.storage.local.get(SECRET_DEFAULTS),
    chrome.storage.sync.get(LOG_SETTING_DEFAULTS)
  ]);
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

function fillSecrets(secrets) {
  Object.entries(API_KEY_INPUTS).forEach(([key, input]) => {
    input.value = secrets[key] || SECRET_DEFAULTS[key];
  });
}

function readSecrets() {
  return Object.fromEntries(
    Object.entries(API_KEY_INPUTS).map(([key, input]) => [key, input.value.trim()])
  );
}

async function save() {
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

function selectTab(tab) {
  const isKeys = tab === "keys";
  keysTab.classList.toggle("active", isKeys);
  logsTab.classList.toggle("active", !isKeys);
  keysTab.setAttribute("aria-selected", String(isKeys));
  logsTab.setAttribute("aria-selected", String(!isKeys));
  keysPanel.hidden = !isKeys;
  logsPanel.hidden = isKeys;
  if (!isKeys) renderLogs().catch((error) => setMessage(error.message || "사용 로그를 불러오지 못했습니다."));
}

function setMessage(text) {
  message.textContent = text;
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    setMessage(error.message || "작업에 실패했습니다.");
  }
}
