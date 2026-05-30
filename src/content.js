const DEFAULT_SETTINGS = globalThis.BIT_DEFAULT_SETTINGS;

const BLOCK_SELECTOR = [
  "article p",
  "main p",
  "section p",
  "p",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "summary",
  "figcaption",
  "caption",
  "dt",
  "dd",
  "label",
  "legend",
  "a",
  "button",
  "span[data-as='p']",
  "td",
  "th",
  "[role='heading']",
  "[role='listitem']",
  "[role='link']",
  "[role='button']"
].join(",");

const TEXT_CONTAINER_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "summary",
  "figcaption",
  "caption",
  "dt",
  "dd",
  "a",
  "button",
  "span[data-as='p']",
  "td",
  "th",
  "[role='heading']",
  "[role='listitem']",
  "[role='link']",
  "[role='button']"
].join(",");

const EXCLUDED_SELECTOR = [
  ".bit-translation",
  ".bit-hidden-original",
  "[hidden]",
  "[aria-hidden='true']",
  "script",
  "style",
  "noscript",
  "textarea",
  "input",
  "select",
  "code",
  "pre",
  "svg",
  "canvas",
  "[contenteditable='true']"
].join(",");

const instanceId = `bit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SPLIT_SCROLL_THROTTLE_MS = 120;
const SPLIT_SCROLL_SUPPRESS_MS = 700;
const runtimeState = {
  activeRun: 0,
  settings: { ...DEFAULT_SETTINGS },
  autoTranslateTimer: null,
  isAutoTranslating: false,
  isSplitTargetTranslating: false,
  nextBlockId: 1,
  contextAlive: true,
  lastViewportSignature: "",
  cleanupHandlers: []
};
const splitState = {
  active: false,
  role: null,
  splitId: null,
  scrollTimer: null,
  releaseTimer: null,
  suppressUntil: 0,
  lastSentKey: "",
  translationCache: new Map(),
  textReplacements: new Map()
};

if (typeof window.__bitTranslatorCleanup === "function") {
  try {
    window.__bitTranslatorCleanup();
  } catch {
    // Ignore stale cleanup failures after extension reloads.
  }
}
window.__bitTranslatorCleanup = cleanupContentScript;

window.addEventListener("unhandledrejection", (event) => {
  if (!isContextInvalidatedError(event.reason)) return;
  event.preventDefault();
  disableRuntime();
});

initializeContentScript();

function initializeContentScript() {
  if (!isExtensionContextAlive()) return;

  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (stored) => {
    if (chrome.runtime.lastError || !isExtensionContextAlive()) {
      disableRuntime();
      return;
    }
    runtimeState.settings = { ...DEFAULT_SETTINGS, ...stored, enabled: false };
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !runtimeState.contextAlive) return;
    for (const [key, change] of Object.entries(changes)) {
      if (key === "enabled") continue;
      runtimeState.settings[key] = change.newValue;
    }
  });

  addDomListener(window, "scroll", handlePossibleViewportChange, { passive: true, capture: true });
  addDomListener(document, "scroll", handlePossibleViewportChange, { passive: true, capture: true });
  addDomListener(window, "wheel", handlePossibleViewportChange, { passive: true });
  addDomListener(window, "touchend", handlePossibleViewportChange, { passive: true });
  addDomListener(window, "keyup", handlePossibleViewportChange);
  addDomListener(window, "resize", handlePossibleViewportChange, { passive: true });

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  runtimeState.cleanupHandlers.push(() => chrome.runtime.onMessage.removeListener(handleRuntimeMessage));
}

function addDomListener(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  runtimeState.cleanupHandlers.push(() => target.removeEventListener(type, listener, options));
}

function cleanupContentScript() {
  runtimeState.contextAlive = false;
  stopTranslationRuntime();
  while (runtimeState.cleanupHandlers.length > 0) {
    const cleanup = runtimeState.cleanupHandlers.pop();
    try {
      cleanup();
    } catch {
      // Best effort cleanup for reinjected content scripts.
    }
  }
}

function handleRuntimeMessage(message, _sender, sendResponse) {
  if (message?.type === "TRANSLATE_PAGE") {
    translatePage(message.options || {})
      .then((result) => safeSendResponse(sendResponse, { ok: true, ...result }))
      .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message || "Translation failed" }));
    return true;
  }

  if (message?.type === "START_SPLIT_SOURCE") {
    startSplitSource(message)
      .then((result) => safeSendResponse(sendResponse, { ok: true, ...result }))
      .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message || "Split source failed" }));
    return true;
  }

  if (message?.type === "START_SPLIT_TARGET") {
    startSplitTarget(message)
      .then((result) => safeSendResponse(sendResponse, { ok: true, ...result }))
      .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message || "Split target translation failed" }));
    return true;
  }

  if (message?.type === "APPLY_SPLIT_SCROLL") {
    applySplitScroll(message);
    safeSendResponse(sendResponse, { ok: true });
    return false;
  }

  if (message?.type === "SCROLL_TO_BLOCK") {
    scrollToBlock(message.blockId);
    safeSendResponse(sendResponse, { ok: true });
    return false;
  }

  if (message?.type === "CLEAR_TRANSLATIONS") {
    cancelActiveTranslations();
    stopTranslationRuntime();
    clearTranslations();
    safeSendResponse(sendResponse, { ok: true });
    return false;
  }

  if (message?.type === "GET_PAGE_STATUS") {
    safeSendResponse(sendResponse, {
      ok: true,
      translatedCount:
        document.querySelectorAll(".bit-translation").length +
        document.querySelectorAll(".bit-replaced").length +
        splitState.textReplacements.size
    });
    return false;
  }

  return false;
}

function cancelActiveTranslations() {
  runtimeState.activeRun += 1;
  return runtimeState.activeRun;
}

function isActiveRun(runId) {
  return runId === runtimeState.activeRun;
}

function mergeRuntimeSettings(overrides) {
  runtimeState.settings = { ...runtimeState.settings, ...overrides };
  return runtimeState.settings;
}

async function translatePage(overrides = {}) {
  if (!runtimeState.contextAlive) return { translatedCount: 0, skippedCount: 0 };
  const runId = cancelActiveTranslations();
  mergeRuntimeSettings(overrides);
  if (!overrides.auto) stopSplitMode();
  if (!overrides.auto) syncAutoMode();

  if (!runtimeState.settings.enabled) clearTranslations();
  const blocks = collectBlocks(runtimeState.settings);
  if (blocks.length === 0) return { translatedCount: 0, skippedCount: 0 };

  let translatedCount = 0;
  const batchSize = getTranslationBatchSize(runtimeState.settings);
  const groups = groupBlocksByText(blocks);

  for (let index = 0; index < groups.length; index += batchSize) {
    if (!isActiveRun(runId)) break;

    const batch = groups.slice(index, index + batchSize);
    markPending(batch.flatMap((group) => group.blocks));

    const response = await sendRuntimeMessage({
      type: "TRANSLATE_BATCH",
      texts: batch.map((group) => group.text),
      options: pickRuntimeOptions(runtimeState.settings)
    });

    if (!response) {
      return { translatedCount, skippedCount: blocks.length - translatedCount };
    }

    if (!response.ok) {
      markFailed(batch.flatMap((group) => group.blocks), response?.error || "Translation failed");
      throw new Error(response?.error || "Translation failed");
    }

    response.translations.forEach((translation, offset) => {
      const group = batch[offset];
      if (!group || !translation || !isActiveRun(runId)) return;
      group.blocks.forEach((item) => {
        renderTranslation(item.element, translation, runtimeState.settings.displayMode);
        translatedCount += 1;
      });
    });
  }

  return { translatedCount, skippedCount: blocks.length - translatedCount };
}

async function startSplitSource(message = {}) {
  const options = getMessageOptions(message);
  cancelActiveTranslations();
  clearTranslations();
  mergeRuntimeSettings({ ...options, enabled: false });
  stopAutoMode();
  startSplitMode("source", message);
  return { translatedCount: 0, skippedCount: 0 };
}

async function startSplitTarget(message = {}) {
  const options = getMessageOptions(message);
  clearTranslations();
  startSplitMode("target", message);
  return translateSplitTarget({
    ...options,
    viewMode: "inline",
    displayMode: "replace",
    enabled: true
  });
}

function startSplitMode(role, message = {}) {
  splitState.active = true;
  splitState.role = role;
  splitState.splitId = message.splitId || message.sessionId || message.options?.splitId || null;
  resetSplitScrollTracking();
  scheduleSplitScroll({ immediate: true });
}

function getMessageOptions(message = {}) {
  if (message.options && typeof message.options === "object") return message.options;
  return pickRuntimeOptions(message);
}

function scheduleAutoTranslate() {
  if (!runtimeState.contextAlive) return;
  window.clearTimeout(runtimeState.autoTranslateTimer);
  runtimeState.autoTranslateTimer = window.setTimeout(() => {
    translateVisibleIfEnabled().catch((error) => {
      if (!isContextInvalidatedError(error)) console.warn("Auto translation failed", error);
    });
  }, 350);
}

function handlePossibleViewportChange() {
  if (
    runtimeState.contextAlive &&
    runtimeState.settings.enabled &&
    runtimeState.settings.translateScope === "viewport"
  ) {
    scheduleAutoTranslate();
  }
  scheduleSplitScroll();
}

function scheduleSplitScroll({ immediate = false } = {}) {
  if (!canSyncSplitScroll()) return;

  if (immediate) {
    sendSplitScroll();
    return;
  }

  if (splitState.scrollTimer) return;
  splitState.scrollTimer = window.setTimeout(() => {
    splitState.scrollTimer = null;
    sendSplitScroll();
  }, SPLIT_SCROLL_THROTTLE_MS);
}

function sendSplitScroll() {
  if (!canSyncSplitScroll()) return;
  const scroll = getSplitScrollPosition();
  const key = getSplitScrollKey(scroll);
  if (key === splitState.lastSentKey) return;
  splitState.lastSentKey = key;

  sendRuntimeMessage(buildSplitScrollMessage(scroll), { optional: true }).catch((error) => {
    if (!isContextInvalidatedError(error)) console.warn("Split scroll update failed", error);
  });
}

function applySplitScroll(message) {
  if (!runtimeState.contextAlive || !splitState.active) return;
  const incoming = message.scroll || message.position || message;
  if (isOwnSplitScrollMessage(message, incoming)) return;

  const target = resolveSplitScrollTarget(incoming);
  if (!target) return;

  if (isNearScrollTarget(getWindowScrollPoint(), target)) return;

  const releaseAt = beginSplitScrollSuppression();
  window.scrollTo({ left: target.x, top: target.y, behavior: "auto" });
  scheduleSplitScrollRelease(releaseAt);

  if (runtimeState.settings.enabled && runtimeState.settings.translateScope === "viewport") scheduleAutoTranslate();
}

function canSyncSplitScroll() {
  return runtimeState.contextAlive && splitState.active && !isSplitScrollSuppressed();
}

function isSplitScrollSuppressed() {
  return Date.now() < splitState.suppressUntil;
}

function resetSplitScrollTracking() {
  splitState.suppressUntil = 0;
  splitState.lastSentKey = "";
  clearSplitScrollTimer();
}

function clearSplitScrollTimer() {
  window.clearTimeout(splitState.scrollTimer);
  splitState.scrollTimer = null;
}

function clearSplitReleaseTimer() {
  window.clearTimeout(splitState.releaseTimer);
  splitState.releaseTimer = null;
}

function getSplitScrollKey(scroll) {
  return [
    Math.round(scroll.x),
    Math.round(scroll.y),
    Math.round(scroll.maxX),
    Math.round(scroll.maxY),
    splitState.role,
    splitState.splitId || ""
  ].join(":");
}

function buildSplitScrollMessage(scroll) {
  return {
    type: "SPLIT_SCROLL",
    role: splitState.role,
    splitRole: splitState.role,
    splitId: splitState.splitId,
    instanceId,
    href: window.location.href,
    ...scroll,
    scroll
  };
}

function isOwnSplitScrollMessage(message, incoming) {
  const incomingInstanceId = message.instanceId || incoming.instanceId || message.originInstanceId;
  return incomingInstanceId && incomingInstanceId === instanceId;
}

function getWindowScrollPoint() {
  return {
    x: window.scrollX || document.scrollingElement?.scrollLeft || 0,
    y: window.scrollY || document.scrollingElement?.scrollTop || 0
  };
}

function isNearScrollTarget(current, target) {
  return Math.abs(current.x - target.x) < 2 && Math.abs(current.y - target.y) < 2;
}

function beginSplitScrollSuppression() {
  const releaseAt = Date.now() + SPLIT_SCROLL_SUPPRESS_MS;
  splitState.suppressUntil = releaseAt;
  clearSplitScrollTimer();
  clearSplitReleaseTimer();
  return releaseAt;
}

function scheduleSplitScrollRelease(releaseAt) {
  splitState.releaseTimer = window.setTimeout(() => {
    if (splitState.suppressUntil === releaseAt) splitState.suppressUntil = 0;
  }, SPLIT_SCROLL_SUPPRESS_MS);
}

function getSplitScrollPosition() {
  const metrics = getSplitScrollMetrics();
  const anchor = getSplitScrollAnchor();

  return {
    ...metrics,
    anchor,
    anchorKey: anchor?.key || "",
    anchorOccurrence: anchor?.occurrence ?? -1,
    anchorViewportTop: anchor?.viewportTop ?? 0,
    at: Date.now()
  };
}

function getSplitScrollMetrics() {
  const scrollingElement = document.scrollingElement || document.documentElement;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const documentWidth = Math.max(scrollingElement.scrollWidth, document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
  const documentHeight = Math.max(scrollingElement.scrollHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
  const maxX = Math.max(0, documentWidth - viewportWidth);
  const maxY = Math.max(0, documentHeight - viewportHeight);
  const x = window.scrollX || scrollingElement.scrollLeft || 0;
  const y = window.scrollY || scrollingElement.scrollTop || 0;

  return {
    x,
    y,
    scrollX: x,
    scrollY: y,
    maxX,
    maxY,
    ratioX: maxX > 0 ? x / maxX : 0,
    ratioY: maxY > 0 ? y / maxY : 0,
    viewportWidth,
    viewportHeight,
    documentWidth,
    documentHeight
  };
}

function resolveSplitScrollTarget(scroll) {
  const anchorTarget = resolveSplitAnchorScrollTarget(scroll.anchor || scroll);
  if (anchorTarget) return anchorTarget;

  const current = getSplitScrollMetrics();
  const ratioX = firstFinite(scroll.ratioX, scroll.xRatio, scroll.leftRatio);
  const ratioY = firstFinite(scroll.ratioY, scroll.yRatio, scroll.topRatio, scroll.ratio);
  const rawX = firstFinite(scroll.x, scroll.scrollX, scroll.left);
  const rawY = firstFinite(scroll.y, scroll.scrollY, scroll.top);
  const x = ratioX === null ? rawX : ratioX * current.maxX;
  const y = ratioY === null ? rawY : ratioY * current.maxY;

  if (x === null && y === null) return null;
  return {
    x: clamp(Math.round(x ?? current.x), 0, current.maxX),
    y: clamp(Math.round(y ?? current.y), 0, current.maxY)
  };
}

function getSplitScrollAnchor() {
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const preferredTop = Math.min(Math.max(80, viewportHeight * 0.18), viewportHeight * 0.45);
  const candidates = [];

  collectSplitAnchorUnits().forEach((unit) => {
    const rect = getTextUnitRect(unit);
    if (!rect || rect.bottom < 0 || rect.top > viewportHeight) return;
    candidates.push({
      unit,
      rect,
      score: Math.abs(rect.top - preferredTop)
    });
  });

  candidates.sort((a, b) => a.score - b.score || a.rect.top - b.rect.top);
  const best = candidates[0];
  if (!best) return null;

  return {
    key: best.unit.key,
    occurrence: best.unit.occurrence,
    viewportTop: clamp(Math.round(best.rect.top), 0, Math.max(0, viewportHeight - 1))
  };
}

function resolveSplitAnchorScrollTarget(anchor) {
  const key = anchor?.key || anchor?.anchorKey;
  const occurrence = Number(anchor?.occurrence ?? anchor?.anchorOccurrence);
  if (!key || !Number.isInteger(occurrence)) return null;

  const unit = findSplitAnchorUnit(key, occurrence);
  if (!unit) return null;

  const rect = getTextUnitRect(unit);
  if (!rect) return null;

  const current = getSplitScrollMetrics();
  const desiredViewportTop = clamp(
    Number(anchor.viewportTop ?? anchor.anchorViewportTop) || 0,
    0,
    Math.max(0, current.viewportHeight - 1)
  );

  return {
    x: current.x,
    y: clamp(Math.round(current.y + rect.top - desiredViewportTop), 0, current.maxY)
  };
}

function syncAutoMode() {
  if (
    runtimeState.contextAlive &&
    runtimeState.settings.enabled &&
    runtimeState.settings.translateScope === "viewport"
  ) {
    startAutoMode();
  } else {
    stopAutoMode();
  }
}

function startAutoMode() {
  scheduleAutoTranslate();
}

function stopAutoMode() {
  window.clearTimeout(runtimeState.autoTranslateTimer);
  runtimeState.autoTranslateTimer = null;
}

async function translateVisibleIfEnabled() {
  if (
    !runtimeState.contextAlive ||
    !runtimeState.settings.enabled ||
    runtimeState.isAutoTranslating ||
    runtimeState.isSplitTargetTranslating
  ) {
    return;
  }
  const signature = splitState.role === "target" ? getSplitViewportSignature() : getViewportSignature();
  if (signature && signature === runtimeState.lastViewportSignature) return;
  runtimeState.lastViewportSignature = signature;
  runtimeState.isAutoTranslating = true;
  try {
    if (splitState.role === "target") {
      await translateSplitTarget({ ...runtimeState.settings, translateScope: "viewport", enabled: true, auto: true });
    } else {
      await translatePage({ ...runtimeState.settings, translateScope: "viewport", enabled: true, auto: true });
    }
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("Auto translation failed", error);
    }
  } finally {
    runtimeState.isAutoTranslating = false;
  }
}

async function translateSplitTarget(overrides = {}) {
  if (!runtimeState.contextAlive) return { translatedCount: 0, skippedCount: 0 };
  if (overrides.auto && runtimeState.isSplitTargetTranslating) return { translatedCount: 0, skippedCount: 0 };

  const runId = cancelActiveTranslations();
  runtimeState.isSplitTargetTranslating = true;
  try {
    mergeRuntimeSettings({ ...overrides, viewMode: "inline", displayMode: "replace", enabled: true });
    const shouldSyncAutoMode = !overrides.auto;

    const units = collectSplitTextUnits(runtimeState.settings);
    if (units.length === 0) {
      if (shouldSyncAutoMode) syncAutoMode();
      scheduleSplitScroll({ immediate: true });
      return { translatedCount: 0, skippedCount: 0 };
    }

    let { translatedCount, missingGroups } = collectMissingSplitTranslationGroups(units, runtimeState.settings);
    const batchSize = getTranslationBatchSize(runtimeState.settings);

    for (let index = 0; index < missingGroups.length; index += batchSize) {
      if (!isActiveRun(runId)) break;

      const batch = missingGroups.slice(index, index + batchSize);
      const response = await sendRuntimeMessage({
        type: "TRANSLATE_BATCH",
        texts: batch.map((group) => group.text),
        options: pickRuntimeOptions(runtimeState.settings)
      });

      if (!response) {
        return { translatedCount, skippedCount: units.length - translatedCount };
      }

      if (!response.ok) {
        throw new Error(response?.error || "Split target translation failed");
      }

      response.translations.forEach((translation, offset) => {
        const group = batch[offset];
        if (!group || !translation || !isActiveRun(runId)) return;
        const normalizedTranslation = String(translation);
        cacheSplitTranslation(group.key, normalizedTranslation);
        translatedCount += replaceSplitTextUnits(group.units, normalizedTranslation);
      });
    }

    scheduleSplitScroll({ immediate: true });
    if (shouldSyncAutoMode) syncAutoMode();
    return { translatedCount, skippedCount: units.length - translatedCount };
  } finally {
    if (isActiveRun(runId)) runtimeState.isSplitTargetTranslating = false;
  }
}

function getViewportSignature() {
  const blocks = collectBlocks({
    ...runtimeState.settings,
    translateScope: "viewport",
    viewMode: runtimeState.settings.viewMode
  });
  return blocks
    .slice(0, 24)
    .map((item) => `${ensureBlockId(item.element)}:${item.text.slice(0, 80)}`)
    .join("|");
}

function getSplitViewportSignature() {
  return collectSplitTextUnits({ ...runtimeState.settings, translateScope: "viewport" })
    .slice(0, 48)
    .map((unit) => `${ensureBlockId(unit.element)}:${unit.text.slice(0, 80)}`)
    .join("|");
}

function splitCacheKey(text, currentSettings) {
  return [
    currentSettings.provider || DEFAULT_SETTINGS.provider,
    currentSettings.sourceLang || DEFAULT_SETTINGS.sourceLang,
    currentSettings.targetLang || DEFAULT_SETTINGS.targetLang,
    text
  ].join("\u0000");
}

function getCachedSplitTranslation(key) {
  return splitState.translationCache.get(key);
}

function cacheSplitTranslation(key, translation) {
  splitState.translationCache.set(key, translation);
}

function collectBlocks(currentSettings) {
  const seen = new Set();
  const blocks = [];

  for (const element of collectBlockCandidates()) {
    if (seen.has(element) || !isTranslatableElement(element)) continue;
    seen.add(element);
    const block = createTranslatableBlock(element, currentSettings);
    if (block) blocks.push(block);
  }

  return blocks;
}

function collectBlockCandidates() {
  return [
    ...Array.from(document.querySelectorAll(BLOCK_SELECTOR)),
    ...collectTextNodeContainers()
  ];
}

function createTranslatableBlock(element, currentSettings) {
  if (currentSettings.translateScope === "viewport" && !isElementInViewport(element)) return null;

  const text = getElementText(element);
  if (!isUsefulText(text)) return null;
  if (element.dataset.bitTranslatedText === text) return null;
  if (shouldSkipTranslatedText(text, currentSettings)) return null;

  return { element, text };
}

function groupBlocksByText(blocks) {
  return groupDuplicateTextItems(blocks, {
    bucketName: "blocks",
    getText: (block) => block.text
  });
}

function collectMissingSplitTranslationGroups(units, currentSettings) {
  let translatedCount = 0;
  const missingGroups = [];
  const groups = groupDuplicateTextItems(units, {
    bucketName: "units",
    getKey: (unit) => splitCacheKey(unit.text, currentSettings),
    getText: (unit) => unit.text
  });

  groups.forEach((group) => {
    const cachedTranslation = getCachedSplitTranslation(group.key);
    if (cachedTranslation) {
      translatedCount += replaceSplitTextUnits(group.units, cachedTranslation);
      return;
    }

    missingGroups.push(group);
  });

  return { translatedCount, missingGroups };
}

function groupDuplicateTextItems(items, { bucketName, getText, getKey = getText }) {
  const groups = [];
  const byKey = new Map();

  items.forEach((item) => {
    const key = getKey(item);
    if (!byKey.has(key)) {
      const group = { key, text: getText(item), [bucketName]: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key)[bucketName].push(item);
  });

  return groups;
}

function getTranslationBatchSize(currentSettings) {
  return clamp(Number(currentSettings.batchSize) || DEFAULT_SETTINGS.batchSize, 1, 20);
}

function ensureBlockId(element) {
  if (!element.dataset.bitBlockId) {
    element.dataset.bitBlockId = `${instanceId}-${runtimeState.nextBlockId++}`;
  }
  return element.dataset.bitBlockId;
}

function scrollToBlock(blockId) {
  const element = document.querySelector(`[data-bit-block-id="${CSS.escape(blockId)}"]`);
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
}

function collectTextNodeContainers() {
  const containers = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = normalizeText(node.nodeValue || "");
      if (text.length < 2) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(EXCLUDED_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const container = getTextContainer(textNode.parentElement);
    if (container) containers.add(container);
  }

  return Array.from(containers);
}

function collectSplitTextUnits(currentSettings) {
  if (!document.body) return [];
  const units = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return getSplitTextNodeFilter(node, currentSettings);
    }
  });

  while (walker.nextNode()) {
    const unit = createSplitTextUnit(walker.currentNode);
    if (unit) units.push(unit);
  }

  return units;
}

function collectSplitAnchorUnits() {
  if (!document.body) return [];

  const units = [];
  const occurrenceByKey = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isSplitAnchorTextNode(node)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  while (walker.nextNode()) {
    const unit = createSplitAnchorUnit(walker.currentNode, occurrenceByKey);
    if (unit) units.push(unit);
  }

  return units;
}

function findSplitAnchorUnit(key, occurrence) {
  const units = collectSplitAnchorUnits();
  return units.find((unit) => unit.key === key && unit.occurrence === occurrence) || null;
}

function getSplitTextNodeFilter(node, currentSettings) {
  return isTranslatableSplitTextNode(node, currentSettings)
    ? NodeFilter.FILTER_ACCEPT
    : NodeFilter.FILTER_REJECT;
}

function isSplitAnchorTextNode(node) {
  const text = getOriginalTextNodeText(node);
  if (!isUsefulText(text)) return false;

  const parent = node.parentElement;
  if (!parent || parent.closest(EXCLUDED_SELECTOR)) return false;
  if (hasFixedOrStickyAncestor(parent)) return false;
  if (!isElementVisible(parent)) return false;

  return Boolean(getTextNodeRect(node) || parent.getClientRects().length);
}

function hasFixedOrStickyAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    const position = window.getComputedStyle(current).position;
    if (position === "fixed" || position === "sticky") return true;
    current = current.parentElement;
  }
  return false;
}

function isTranslatableSplitTextNode(node, currentSettings) {
  if (splitState.textReplacements.has(node)) return false;

  const text = normalizeText(node.nodeValue || "");
  if (!isUsefulText(text)) return false;
  if (shouldSkipTranslatedText(text, currentSettings)) return false;

  const parent = node.parentElement;
  if (!parent || parent.closest(EXCLUDED_SELECTOR)) return false;
  if (parent.closest(".bit-replaced[data-bit-original-text]")) return false;
  if (!isElementVisible(parent)) return false;
  if (currentSettings.translateScope === "viewport" && !isElementInViewport(parent)) return false;

  return true;
}

function createSplitTextUnit(textNode) {
  const element = textNode.parentElement;
  if (!element) return null;
  return {
    textNode,
    element,
    text: normalizeText(textNode.nodeValue || "")
  };
}

function createSplitAnchorUnit(textNode, occurrenceByKey) {
  const element = textNode.parentElement;
  if (!element) return null;

  const text = getOriginalTextNodeText(textNode);
  const key = makeTextAnchorKey(text);
  const occurrence = occurrenceByKey.get(key) || 0;
  occurrenceByKey.set(key, occurrence + 1);

  return {
    textNode,
    element,
    key,
    occurrence
  };
}

function getOriginalTextNodeText(textNode) {
  const replacement = splitState.textReplacements.get(textNode);
  return normalizeText(replacement?.originalText || textNode.nodeValue || "");
}

function makeTextAnchorKey(text) {
  return `${stableTextHash(text)}:${text.length}`;
}

function stableTextHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getTextUnitRect(unit) {
  return getTextNodeRect(unit.textNode) || getFirstVisibleRect(unit.element);
}

function getTextNodeRect(textNode) {
  if (!textNode?.isConnected) return null;

  const range = document.createRange();
  try {
    range.selectNodeContents(textNode);
    return Array.from(range.getClientRects()).find(isUsableRect) || null;
  } finally {
    range.detach?.();
  }
}

function getFirstVisibleRect(element) {
  return Array.from(element?.getClientRects?.() || []).find(isUsableRect) || null;
}

function isUsableRect(rect) {
  return Boolean(rect && rect.width >= 1 && rect.height >= 1);
}

function shouldSkipTranslatedText(text, currentSettings) {
  return (
    currentSettings.skipTranslated &&
    currentSettings.targetLang === "ko" &&
    looksMostlyKorean(text)
  );
}

function getTextContainer(element) {
  const semanticContainer = element.closest(TEXT_CONTAINER_SELECTOR);
  if (semanticContainer) return semanticContainer;

  let current = element;
  while (current && current !== document.body) {
    if (current.closest(EXCLUDED_SELECTOR)) return null;
    if (isStandaloneTextContainer(current)) return current;
    current = current.parentElement;
  }

  return element;
}

function isStandaloneTextContainer(element) {
  const tag = element.tagName;
  if (["A", "SPAN", "STRONG", "EM", "B", "I", "SMALL", "TIME", "MARK"].includes(tag)) {
    return true;
  }

  if (!["DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE"].includes(tag)) {
    return false;
  }

  const directText = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => normalizeText(node.nodeValue || ""))
    .join(" ")
    .trim();

  return directText.length >= 8;
}

function isTranslatableElement(element) {
  if (element.closest(EXCLUDED_SELECTOR)) {
    return false;
  }

  if (hasTranslatableAncestor(element)) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 8) return false;

  if (!isElementVisible(element)) return false;

  const text = getElementText(element);
  if (text.length > 1600 && !isNaturallyTextBlock(element)) return false;

  return true;
}

function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number(style.opacity) === 0 ||
    style.contentVisibility === "hidden"
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;

  const visibleRects = Array.from(element.getClientRects()).filter((clientRect) => {
    if (clientRect.width < 1 || clientRect.height < 1) return false;
    if (style.position !== "fixed" && isClippedByAncestor(element, clientRect)) return false;
    return true;
  });

  return visibleRects.length > 0;
}

function isElementInViewport(element) {
  const rects = Array.from(element.getClientRects()).filter((rect) => rect.width >= 1 && rect.height >= 1);
  if (rects.length === 0) return false;

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const verticalPadding = viewportHeight * 0.15;

  return rects.some((rect) => (
    rect.bottom >= -verticalPadding &&
    rect.top <= viewportHeight + verticalPadding &&
    rect.right >= 0 &&
    rect.left <= viewportWidth
  ));
}

function isClippedByAncestor(element, rect) {
  let current = element.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const clipsX = ["hidden", "clip", "scroll", "auto"].includes(style.overflowX);
    const clipsY = ["hidden", "clip", "scroll", "auto"].includes(style.overflowY);

    if (clipsX || clipsY) {
      const currentRect = current.getBoundingClientRect();
      const outsideX = clipsX && (rect.right <= currentRect.left || rect.left >= currentRect.right);
      const outsideY = clipsY && (rect.bottom <= currentRect.top || rect.top >= currentRect.bottom);
      if (outsideX || outsideY) return true;
    }

    current = current.parentElement;
  }

  return false;
}

function hasTranslatableAncestor(element) {
  let current = element.parentElement;
  while (current && current !== document.body) {
    if (current.classList?.contains("bit-translation")) return true;
    if (current.matches?.(TEXT_CONTAINER_SELECTOR) && !isNestedListItem(element, current)) return true;
    const currentText = normalizeText(current.innerText || current.textContent || "");
    if (
      currentText.length >= 12 &&
      currentText.length <= 1600 &&
      isNaturallyTextBlock(current) &&
      !isNestedListItem(element, current)
    ) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

function isNestedListItem(element, ancestor) {
  return element.matches("li") && ancestor.matches("li");
}

function isNaturallyTextBlock(element) {
  return element.matches(TEXT_CONTAINER_SELECTOR);
}

function isUsefulText(text) {
  if (text.length < 2 || text.length > 1600) return false;
  if (!/[A-Za-z0-9\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/.test(text)) return false;
  if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text)) return false;
  return true;
}

function getElementText(element) {
  if (element.matches("li, td, th")) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll("ul, ol, table, thead, tbody, tfoot, tr, .bit-translation").forEach((node) => node.remove());
    return normalizeText(clone.innerText || clone.textContent || "");
  }

  return normalizeText(element.innerText || element.textContent || "");
}

function renderTranslation(element, translation, displayMode) {
  element.classList.remove("bit-pending", "bit-failed");
  element.removeAttribute("data-bit-error");
  element.dataset.bitTranslatedText = getElementText(element);
  const sourceId = ensureBlockId(element);

  if (displayMode === "replace") {
    if (element.classList.contains("bit-replaced")) return;
    element.dataset.bitOriginalText = element.textContent || "";
    element.classList.add("bit-replaced");
    element.textContent = translation;
    return;
  }

  const translationNode = createTranslationNode(translation);
  translationNode.dataset.bitSourceId = sourceId;
  document
    .querySelectorAll(`.bit-translation[data-bit-source-id="${CSS.escape(sourceId)}"]`)
    .forEach((node) => node.remove());

  if (element.matches("td, th")) {
    element.appendChild(translationNode);
    return;
  }

  if (element.matches("li")) {
    translationNode.classList.add("bit-translation-list");
    const nestedList = element.querySelector(":scope > ul, :scope > ol");
    if (nestedList) {
      nestedList.insertAdjacentElement("beforebegin", translationNode);
      return;
    }

    element.appendChild(translationNode);
    return;
  }

  element.insertAdjacentElement("afterend", translationNode);
}

function createTranslationNode(translation) {
  const translationNode = document.createElement("div");
  translationNode.className = "bit-translation";
  translationNode.dir = "auto";
  translationNode.textContent = translation;
  return translationNode;
}

function replaceSplitTextUnit(unit, translation) {
  const textNode = unit.textNode;
  if (!textNode?.isConnected || splitState.textReplacements.has(textNode)) return false;
  if (normalizeText(textNode.nodeValue || "") !== unit.text) return false;

  const originalText = textNode.nodeValue || "";
  const translatedText = preserveTextNodeSpacing(originalText, translation);
  splitState.textReplacements.set(textNode, { originalText, translatedText });
  textNode.nodeValue = translatedText;
  return true;
}

function replaceSplitTextUnits(units, translation) {
  return units.reduce((count, unit) => (
    replaceSplitTextUnit(unit, translation) ? count + 1 : count
  ), 0);
}

function preserveTextNodeSpacing(originalText, translation) {
  const leading = originalText.match(/^\s*/)?.[0] || "";
  const trailing = originalText.match(/\s*$/)?.[0] || "";
  return `${leading}${String(translation || "").trim()}${trailing}`;
}

function markPending(batch) {
  batch.forEach(({ element }) => {
    element.classList.add("bit-pending");
    element.classList.remove("bit-failed");
    element.removeAttribute("data-bit-error");
  });
}

function markFailed(batch, message) {
  batch.forEach(({ element }) => {
    element.classList.remove("bit-pending");
    element.classList.add("bit-failed");
    element.dataset.bitError = message;
  });
}

function clearTranslations(options = {}) {
  splitState.translationCache.clear();
  runtimeState.lastViewportSignature = "";
  if (!options.keepSplit) stopSplitMode();
  restoreSplitTextReplacements();
  document.querySelectorAll(".bit-translation").forEach((node) => node.remove());
  document.querySelectorAll(".bit-pending, .bit-failed").forEach((node) => {
    node.classList.remove("bit-pending", "bit-failed");
    node.removeAttribute("data-bit-error");
  });
  document.querySelectorAll("[data-bit-translated-text]").forEach((node) => {
    delete node.dataset.bitTranslatedText;
  });
  document.querySelectorAll(".bit-replaced").forEach((node) => {
    if (node.dataset.bitOriginalText) {
      node.textContent = node.dataset.bitOriginalText;
    }
    node.classList.remove("bit-replaced");
    delete node.dataset.bitOriginalText;
  });
}

function restoreSplitTextReplacements() {
  splitState.textReplacements.forEach((state, textNode) => {
    if (textNode.isConnected && textNode.nodeValue === state.translatedText) {
      textNode.nodeValue = state.originalText;
    }
  });
  splitState.textReplacements.clear();
}

function stopSplitMode() {
  runtimeState.isSplitTargetTranslating = false;
  splitState.active = false;
  splitState.role = null;
  splitState.splitId = null;
  resetSplitScrollTracking();
  clearSplitReleaseTimer();
}

function pickRuntimeOptions(currentSettings) {
  const allowed = ["targetLang", "sourceLang", "viewMode", "displayMode", "translateScope", "skipTranslated", "batchSize", "provider"];
  return Object.fromEntries(Object.entries(currentSettings).filter(([key]) => allowed.includes(key)));
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function looksMostlyKorean(value) {
  const korean = (value.match(/[\uac00-\ud7af]/g) || []).length;
  const letters = (value.match(/[A-Za-z\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return letters > 0 && korean / letters > 0.45;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

async function sendRuntimeMessage(message, { optional = false } = {}) {
  if (!isExtensionContextAlive()) {
    disableRuntime();
    return null;
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      disableRuntime();
      return null;
    }

    if (optional) return null;
    throw error;
  }
}

function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (error) {
    if (!isContextInvalidatedError(error)) throw error;
  }
}

function disableRuntime() {
  runtimeState.contextAlive = false;
  stopTranslationRuntime();
}

function stopTranslationRuntime() {
  runtimeState.settings.enabled = false;
  stopAutoMode();
  stopSplitMode();
}

function isExtensionContextAlive() {
  try {
    return Boolean(runtimeState.contextAlive && chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isContextInvalidatedError(error) {
  const text = error?.message || String(error || "");
  return (
    text.includes("Extension context invalidated") ||
    text.includes("message channel closed") ||
    text.includes("Receiving end does not exist")
  );
}
