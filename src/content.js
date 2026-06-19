(() => {
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

const INLINE_SENTENCE_TAGS = new Set([
  "A", "SPAN", "STRONG", "EM", "B", "I", "SMALL", "TIME", "MARK", "SUP", "SUB",
  "CODE", "KBD", "ABBR", "CITE", "Q", "U", "S", "WBR", "BDI", "BDO", "DFN", "VAR",
  "SAMP", "INS", "DEL", "LABEL", "FONT", "BR"
]);

const EXCLUDED_SELECTOR = [
  ".bit-translation",
  ".bit-retranslate",
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
const SPLIT_SCROLL_SUPPRESS_MS = 700;
const MIRROR_VIEWPORT_WATCH_MS = 500;
const MIRROR_TRANSLATION_DELAY_MS = {
  immediate: 0,
  retry: 80,
  scroll: 90,
  input: 120,
  errorRetry: 1200,
  default: 160
};
const MAX_TRANSLATION_BATCH_SIZE = 50;
const MAX_TRANSLATION_TEXT_LENGTH = 3000;
const FIRST_TRANSLATION_BATCH_SIZE = 2;
const MIRROR_TRANSLATION_BATCH_SIZE = 2;
// Split view translates in progressive top-to-bottom passes.
const MIRROR_TRANSLATION_UNIT_LIMIT = 80;
const MIRROR_SELECTORS = {
  sourcePane: ".bit-mirror-pane-source",
  targetPane: ".bit-mirror-pane-target",
  excludedClone: "script, noscript, iframe, object, embed, .bit-mirror-root, .bit-translation"
};
const MIRROR_TRANSIENT_CLASSES = ["bit-pending", "bit-failed", "bit-replaced"];
const MIRROR_TRANSIENT_ATTRIBUTES = ["data-bit-error", "data-bit-translated-text", "data-bit-original-text"];
const MIRROR_CLONE_NODE_ID_ATTRIBUTE = "data-bit-mirror-node-id";
const TRANSLATION_COUNT_MISMATCH_MESSAGE = "Translation response did not include the expected number of translations.";
const TRANSLATION_MISSING_MESSAGE = "번역 결과를 받지 못했습니다. (원문이 그대로 반환되었을 수 있어요)";
const runtimeState = {
  activeRun: 0,
  settings: { ...DEFAULT_SETTINGS },
  autoTranslateTimer: null,
  isAutoTranslating: false,
  autoTranslatePending: false,
  nextBlockId: 1,
  contextAlive: true,
  lastViewportSignature: "",
  contentObserver: null,
  cleanupHandlers: []
};
// In "replace" mode we move the block's original child nodes into a detached fragment and
// show the translation instead. Keeping the real nodes (not just their textContent) lets us
// restore links/emphasis/structure exactly when the translation is cleared or re-run.
const replacedOriginalNodes = new WeakMap();
const mirrorState = {
  active: false,
  scrollSyncEnabled: true,
  root: null,
  sourcePane: null,
  targetPane: null,
  translateTimer: null,
  viewportWatchTimer: null,
  suppressScrollUntil: 0,
  isTranslating: false,
  needsTranslation: false,
  lastViewportSignature: "",
  originalOverflow: "",
  originalBodyOverflow: "",
  translationCache: new Map(),
  textReplacements: new Map(),
  failedTranslationKeys: new Set(),
  cleanupHandlers: []
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

  const settingsReady = loadInitialSettings();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !runtimeState.contextAlive) return;
    for (const [key, change] of Object.entries(changes)) {
      if (key === "enabled") continue;
      // A removed key reports no `newValue`; fall back to the default instead of
      // writing `undefined` into the live settings (which then leaks into requests).
      runtimeState.settings[key] = change.newValue !== undefined ? change.newValue : DEFAULT_SETTINGS[key];
    }
  });

  addDomListener(window, "scroll", handlePossibleViewportChange, { passive: true, capture: true });
  addDomListener(document, "scroll", handlePossibleViewportChange, { passive: true, capture: true });
  addDomListener(window, "wheel", handlePossibleViewportChange, { passive: true });
  addDomListener(window, "touchend", handlePossibleViewportChange, { passive: true });
  addDomListener(window, "keyup", handlePossibleViewportChange);
  addDomListener(window, "resize", handlePossibleViewportChange, { passive: true });
  addDomListener(document, "click", handleRetranslateClick, true);

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  runtimeState.cleanupHandlers.push(() => chrome.runtime.onMessage.removeListener(handleRuntimeMessage));

  maybeReopenSplitMode(settingsReady);
}

// Resolve once the stored settings have been merged in, so split-view reopen (and anything
// else that depends on live settings) doesn't race the async storage read on page load.
function loadInitialSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (stored) => {
      if (chrome.runtime.lastError || !isExtensionContextAlive()) {
        disableRuntime();
        resolve();
        return;
      }
      runtimeState.settings = { ...DEFAULT_SETTINGS, ...stored, enabled: false };
      resolve();
    });
  });
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

  if (message?.type === "START_IN_PAGE_SPLIT") {
    startInPageSplit(message.options || {})
      .then((result) => safeSendResponse(sendResponse, { ok: true, ...result }))
      .catch((error) => safeSendResponse(sendResponse, { ok: false, error: error.message || "In-page split failed" }));
    return true;
  }

  if (message?.type === "SCROLL_TO_BLOCK") {
    scrollToBlock(message.blockId);
    safeSendResponse(sendResponse, { ok: true });
    return false;
  }

  if (message?.type === "CLEAR_TRANSLATIONS") {
    persistSplitReopen(false);
    cancelActiveTranslations();
    stopTranslationRuntime();
    clearTranslations();
    safeSendResponse(sendResponse, { ok: true });
    return false;
  }

  if (message?.type === "GET_PAGE_STATUS") {
    const inlineTranslatedCount =
      document.querySelectorAll(".bit-translation").length +
      document.querySelectorAll(".bit-replaced").length;
    safeSendResponse(sendResponse, {
      ok: true,
      viewMode: mirrorState.active ? "split" : inlineTranslatedCount > 0 ? "inline" : null,
      translatedCount:
        inlineTranslatedCount +
        mirrorState.textReplacements.size +
        (mirrorState.active ? 1 : 0)
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

// Shared batch loop for every translation mode: slices `groups` into TRANSLATE_BATCH
// requests and lets the caller apply each translation. `applyTranslation` returns how
// many items it rendered, which is summed into the returned `translatedCount`.
async function runTranslationBatches(groups, {
  runId,
  batchSize: requestedBatchSize,
  shouldContinue = () => isActiveRun(runId),
  onBatchStart,
  onBatchError,
  onTranslationMissing,
  errorMessage = "Translation failed",
  applyTranslation
}) {
  const batchSize = normalizeTranslationBatchSize(requestedBatchSize ?? runtimeState.settings.batchSize);
  let translatedCount = 0;
  let failedCount = 0;
  let index = 0;

  if (groups.length > 0 && batchSize > FIRST_TRANSLATION_BATCH_SIZE && shouldContinue()) {
    const firstBatchSize = Math.min(FIRST_TRANSLATION_BATCH_SIZE, groups.length);
    const result = await runTranslationBatch(groups.slice(0, firstBatchSize), {
      runId,
      shouldContinue,
      onBatchStart,
      onBatchError,
      onTranslationMissing,
      errorMessage,
      applyTranslation
    });

    translatedCount += result.translatedCount;
    failedCount += result.failedCount || 0;
    if (result.aborted) return { translatedCount, failedCount, aborted: true };
    index = firstBatchSize;
  }

  for (; index < groups.length; index += batchSize) {
    if (!shouldContinue()) break;

    const result = await runTranslationBatch(groups.slice(index, index + batchSize), {
      runId,
      shouldContinue,
      onBatchStart,
      onBatchError,
      onTranslationMissing,
      errorMessage,
      applyTranslation
    });

    translatedCount += result.translatedCount;
    failedCount += result.failedCount || 0;
    if (result.aborted) return { translatedCount, failedCount, aborted: true };
  }

  return { translatedCount, failedCount, aborted: false };
}

async function runTranslationBatch(batch, {
  runId,
  shouldContinue,
  onBatchStart,
  onBatchError,
  onTranslationMissing,
  errorMessage,
  applyTranslation
}) {
  onBatchStart?.(batch);

  const response = await sendRuntimeMessage({
    type: "TRANSLATE_BATCH",
    texts: batch.map((group) => group.text),
    options: pickRuntimeOptions(runtimeState.settings)
  });

  if (!response) return { translatedCount: 0, failedCount: 0, aborted: true };

  if (!response.ok) {
    const message = response?.error || errorMessage;
    if (batch.length > 1 && shouldTrySingleTranslationFallback(message)) {
      return runSingleTranslationFallback(batch, {
        runId,
        shouldContinue,
        onBatchError,
        onTranslationMissing,
        errorMessage,
        applyTranslation
      });
    }

    onBatchError?.(batch, message);
    if (isTranslationCountMismatchError(message)) {
      return { translatedCount: 0, failedCount: batch.length, aborted: false };
    }
    if (isFatalTranslationError(message)) throw new Error(message);
    return { translatedCount: 0, failedCount: batch.length, aborted: shouldStopAfterBatchError(message) };
  }

  const translations = Array.isArray(response.translations) ? response.translations : [];
  if (translations.length !== batch.length) {
    if (batch.length > 1) {
      return runSingleTranslationFallback(batch, {
        runId,
        shouldContinue,
        onBatchError,
        onTranslationMissing,
        errorMessage,
        applyTranslation
      });
    }

    onBatchError?.(batch, TRANSLATION_COUNT_MISMATCH_MESSAGE);
    return { translatedCount: 0, failedCount: batch.length, aborted: false };
  }

  let translatedCount = 0;
  let missingCount = 0;
  translations.forEach((translation, offset) => {
    const group = batch[offset];
    if (!group || !shouldContinue() || !isActiveRun(runId)) return;
    // A null translation means the provider couldn't translate this item (e.g. an echoed
    // source the background nulled, or a per-item REST failure). The block was marked
    // pending in onBatchStart, so it must be cleared here or it spins forever.
    if (translation == null) {
      missingCount += 1;
      onTranslationMissing?.(group);
      return;
    }
    translatedCount += applyTranslation(group, translation);
  });

  return { translatedCount, failedCount: missingCount, aborted: false };
}

async function runSingleTranslationFallback(groups, {
  runId,
  shouldContinue,
  onBatchError,
  onTranslationMissing,
  errorMessage,
  applyTranslation
}) {
  let translatedCount = 0;
  let failedCount = 0;

  for (const group of groups) {
    if (!shouldContinue()) break;

    const response = await sendRuntimeMessage({
      type: "TRANSLATE_BATCH",
      texts: [group.text],
      options: pickRuntimeOptions(runtimeState.settings)
    });

    if (!response) return { translatedCount, failedCount, aborted: true };

    if (!response.ok) {
      const message = response?.error || errorMessage;
      onBatchError?.([group], message);
      if (!isTranslationCountMismatchError(message) && isFatalTranslationError(message)) {
        throw new Error(message);
      }
      failedCount += 1;
      if (shouldStopAfterBatchError(message)) return { translatedCount, failedCount, aborted: true };
      continue;
    }

    const translations = Array.isArray(response.translations) ? response.translations : [];
    if (translations.length !== 1) {
      onBatchError?.([group], TRANSLATION_COUNT_MISMATCH_MESSAGE);
      failedCount += 1;
      continue;
    }

    if (!isActiveRun(runId)) continue;

    const [translation] = translations;
    if (translation == null) {
      failedCount += 1;
      onTranslationMissing?.(group);
      continue;
    }
    translatedCount += applyTranslation(group, translation);
  }

  return { translatedCount, failedCount, aborted: false };
}

function isTranslationCountMismatchError(message) {
  return String(message || "").includes(TRANSLATION_COUNT_MISMATCH_MESSAGE);
}

function shouldTrySingleTranslationFallback(message) {
  if (isTranslationCountMismatchError(message)) return true;
  const text = String(message || "").toLowerCase();
  return text.includes("request failed: 400");
}

function isFatalTranslationError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("api key is missing") ||
    text.includes("request failed: 400") ||
    text.includes("request failed: 401") ||
    text.includes("request failed: 403") ||
    text.includes("request failed: 404")
  );
}

function shouldStopAfterBatchError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("request failed: 408") ||
    text.includes("request failed: 429") ||
    text.includes("request failed: 500") ||
    text.includes("request failed: 502") ||
    text.includes("request failed: 503") ||
    text.includes("request failed: 504") ||
    text.includes("failed to fetch")
  );
}

async function translatePage(overrides = {}) {
  if (!runtimeState.contextAlive) return { translatedCount: 0, skippedCount: 0 };
  if (overrides.viewMode === "split") {
    if (overrides.auto && mirrorState.active) {
      scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.retry);
      return { translatedCount: 0, skippedCount: 0 };
    }
    return startInPageSplit(overrides);
  }

  const runId = cancelActiveTranslations();
  mergeRuntimeSettings(overrides);
  if (!overrides.auto) {
    persistSplitReopen(false);
    syncAutoMode();
  }

  if (!runtimeState.settings.enabled) clearTranslations();
  const blocks = collectBlocks(runtimeState.settings);
  if (blocks.length === 0) return { translatedCount: 0, skippedCount: 0 };

  const groups = groupBlocksByText(blocks);
  const { translatedCount, failedCount } = await runTranslationBatches(groups, {
    runId,
    onBatchStart: (batch) => markPending(batch.flatMap((group) => group.blocks)),
    onBatchError: (batch, message) => markTranslationBatchError(batch, message, { quiet: Boolean(overrides.auto) }),
    onTranslationMissing: (group) => markTranslationBatchError([group], TRANSLATION_MISSING_MESSAGE, { quiet: Boolean(overrides.auto) }),
    applyTranslation: (group, translation) => {
      group.blocks.forEach((item) => renderTranslation(item.element, translation, runtimeState.settings.displayMode));
      return group.blocks.length;
    }
  });

  return { translatedCount, failedCount, skippedCount: Math.max(0, blocks.length - translatedCount - failedCount) };
}

async function startInPageSplit(overrides = {}) {
  if (!runtimeState.contextAlive) return { translatedCount: 0, skippedCount: 0 };

  const runId = cancelActiveTranslations();
  mergeRuntimeSettings({ ...overrides, viewMode: "split", translateScope: "viewport", enabled: true });
  prepareMirrorMode();

  try {
    const root = createMirrorRoot();
    mountMirrorRoot(root);
    activateMirrorState(root);
  } catch (error) {
    restoreMirrorPageOverflow();
    resetMirrorState();
    throw error;
  }

  if (!isActiveRun(runId) || !mirrorState.active) return { translatedCount: 0, skippedCount: 0 };

  setupMirrorScrollSync();
  persistSplitReopen(true);

  return translateMirrorViewport({ runId });
}

function prepareMirrorMode() {
  stopAutoMode();
  clearTranslations({ keepMirror: true });
  stopMirrorMode();
}

function mountMirrorRoot(root) {
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  document.body.appendChild(root);
}

function activateMirrorState(root) {
  const sourcePane = root.querySelector(MIRROR_SELECTORS.sourcePane);
  const targetPane = root.querySelector(MIRROR_SELECTORS.targetPane);
  if (!sourcePane || !targetPane) throw new Error("분할 화면을 생성하지 못했습니다.");

  mirrorState.active = true;
  mirrorState.root = root;
  mirrorState.sourcePane = sourcePane;
  mirrorState.targetPane = targetPane;
}

function createMirrorRoot() {
  mirrorState.originalOverflow = document.documentElement.style.overflow;
  mirrorState.originalBodyOverflow = document.body.style.overflow;

  const root = document.createElement("div");
  root.className = "bit-mirror-root";
  root.innerHTML = `
    <div class="bit-mirror-toolbar">
      <strong>분할 번역</strong>
      <span>왼쪽은 원문, 오른쪽은 번역입니다.</span>
      <button class="bit-mirror-sync is-active" type="button" aria-pressed="true" title="원문과 번역을 함께 스크롤합니다">페이지 함께 움직이기</button>
      <button class="bit-mirror-close" type="button" aria-label="분할 번역 닫기">닫기</button>
    </div>
    <div class="bit-mirror-grid">
      <div class="bit-mirror-pane bit-mirror-pane-source" role="region" aria-label="원문"></div>
      <div class="bit-mirror-pane bit-mirror-pane-target" role="region" aria-label="번역"></div>
    </div>
  `;

  cloneMirrorBodyIntoPanes(root);

  root.querySelector(".bit-mirror-close").addEventListener("click", () => {
    persistSplitReopen(false);
    cancelActiveTranslations();
    stopMirrorMode();
  });

  root.querySelector(".bit-mirror-sync").addEventListener("click", () => {
    setMirrorScrollSync(!mirrorState.scrollSyncEnabled);
  });

  return root;
}

function cloneMirrorBodyIntoPanes(root) {
  const sourcePane = root.querySelector(MIRROR_SELECTORS.sourcePane);
  const targetPane = root.querySelector(MIRROR_SELECTORS.targetPane);
  if (!sourcePane || !targetPane) return;

  const cloneContext = createMirrorCloneContext();
  Array.from(document.body.childNodes).forEach((node) => {
    if (node === root || shouldSkipMirrorCloneNode(node)) return;
    sourcePane.appendChild(createSanitizedMirrorClone(node, cloneContext));
    targetPane.appendChild(createSanitizedMirrorClone(node, cloneContext));
  });
}

function shouldSkipMirrorCloneNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  return node.matches(MIRROR_SELECTORS.excludedClone);
}

function createMirrorCloneContext() {
  return {
    nextNodeId: 1,
    nodeIds: new WeakMap()
  };
}

function createSanitizedMirrorClone(node, cloneContext) {
  const clone = node.cloneNode(true);
  sanitizeMirrorClone(clone, node, cloneContext);
  return clone;
}

function sanitizeMirrorClone(cloneRoot, sourceRoot, cloneContext) {
  sanitizeMirrorCloneNode(cloneRoot, sourceRoot, cloneContext);
}

function sanitizeMirrorCloneNode(cloneNode, sourceNode, cloneContext) {
  if (cloneNode.nodeType === Node.ELEMENT_NODE && cloneNode.matches(MIRROR_SELECTORS.excludedClone)) {
    cloneNode.remove();
    return;
  }

  // Drop fixed/sticky overlays (cookie banners, sticky chrome, floating widgets): inside a
  // scrollable cloned pane they float, overlap content, and can't be interacted with.
  if (
    cloneNode.nodeType === Node.ELEMENT_NODE &&
    sourceNode?.nodeType === Node.ELEMENT_NODE &&
    isFixedOrStickyElement(sourceNode)
  ) {
    cloneNode.remove();
    return;
  }

  if (cloneNode.nodeType === Node.ELEMENT_NODE) {
    sanitizeMirrorCloneElement(
      cloneNode,
      sourceNode?.nodeType === Node.ELEMENT_NODE ? sourceNode : null,
      cloneContext
    );
  }

  const sourceChildren = Array.from(sourceNode?.childNodes || []);
  Array.from(cloneNode.childNodes || []).forEach((child, index) => {
    sanitizeMirrorCloneNode(child, sourceChildren[index], cloneContext);
  });
}

function sanitizeMirrorCloneElement(element, sourceElement, cloneContext) {
  element.classList.remove(...MIRROR_TRANSIENT_CLASSES);
  MIRROR_TRANSIENT_ATTRIBUTES.forEach((attribute) => element.removeAttribute(attribute));

  // The original body stays in the (hidden) document while two clones are mounted, so every
  // `id` would otherwise exist three times — invalid HTML that breaks getElementById, in-page
  // `#fragment` anchors, `:target`, and label/aria id references. Drop ids from the display-only
  // clones (scroll-sync uses data-bit-mirror-node-id instead). The only cost is page CSS written
  // against `#id` selectors not styling the mirrored copy.
  element.removeAttribute("id");

  Array.from(element.attributes).forEach((attribute) => {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name === "srcdoc" || name === "autofocus") {
      element.removeAttribute(attribute.name);
    }
  });

  if (!sourceElement) return;

  element.setAttribute(MIRROR_CLONE_NODE_ID_ATTRIBUTE, getMirrorCloneNodeId(sourceElement, cloneContext));
}

function getMirrorCloneNodeId(sourceElement, cloneContext) {
  if (!cloneContext.nodeIds.has(sourceElement)) {
    cloneContext.nodeIds.set(sourceElement, `${instanceId}-mirror-${cloneContext.nextNodeId++}`);
  }

  return cloneContext.nodeIds.get(sourceElement);
}

function isFixedOrStickyElement(element) {
  const position = window.getComputedStyle(element).position;
  return position === "fixed" || position === "sticky";
}

function setupMirrorScrollSync() {
  addMirrorPaneScrollListener(mirrorState.sourcePane, mirrorState.targetPane);
  addMirrorPaneScrollListener(mirrorState.targetPane, mirrorState.sourcePane);
  addMirrorLinkInterception(mirrorState.sourcePane);
  addMirrorLinkInterception(mirrorState.targetPane);
  startMirrorViewportWatcher();
  scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.immediate);
}

function setMirrorScrollSync(enabled) {
  mirrorState.scrollSyncEnabled = enabled;
  const button = mirrorState.root?.querySelector(".bit-mirror-sync");
  if (button) {
    button.classList.toggle("is-active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
  }
  if (enabled && mirrorState.active && mirrorState.sourcePane && mirrorState.targetPane) {
    syncMirrorScroll(mirrorState.sourcePane, mirrorState.targetPane);
  }
}

async function maybeReopenSplitMode(settingsReady) {
  await settingsReady;
  const response = await sendRuntimeMessage({ type: "GET_SPLIT_REOPEN" }, { optional: true });
  if (!response?.ok || !response.reopen) return;

  try {
    await startInPageSplit(response.options || {});
  } catch (error) {
    if (!isContextInvalidatedError(error)) console.warn("Split reopen failed", error);
  }
}

function persistSplitReopen(reopen) {
  return sendRuntimeMessage({
    type: "SET_SPLIT_REOPEN",
    reopen,
    options: pickRuntimeOptions(runtimeState.settings)
  }, { optional: true }).catch(() => {});
}

function addMirrorLinkInterception(pane) {
  if (!pane) return;
  addMirrorPaneListener(pane, "click", handleMirrorLinkClick, { capture: true });
}

function handleMirrorLinkClick(event) {
  if (!mirrorState.active) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const anchor = event.target?.closest?.("a[href]");
  if (!anchor) return;

  const linkTarget = (anchor.getAttribute("target") || "").toLowerCase();
  if (linkTarget && linkTarget !== "_self") return;

  if (!isFullPageNavigation(anchor.href)) return;

  event.preventDefault();
  event.stopPropagation();
  reopenSplitAfterNavigation(anchor.href);
}

function isFullPageNavigation(href) {
  try {
    const target = new URL(href, window.location.href);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;

    const current = new URL(window.location.href);
    const sameDocument =
      target.origin === current.origin &&
      target.pathname === current.pathname &&
      target.search === current.search;
    return !sameDocument;
  } catch {
    return false;
  }
}

async function reopenSplitAfterNavigation(href) {
  await persistSplitReopen(true);
  window.location.assign(href);
}

function addMirrorPaneScrollListener(fromPane, toPane) {
  if (!fromPane || !toPane) return;

  const onScroll = (event) => {
    if (!mirrorState.active) return;
    if (mirrorState.scrollSyncEnabled && Date.now() >= mirrorState.suppressScrollUntil) {
      const syncedNestedScroll = syncMirrorNestedScroll(event.target, fromPane, toPane);
      if (!syncedNestedScroll) syncMirrorScroll(fromPane, toPane);
    }
    scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.scroll);
  };

  const onViewportInput = () => {
    if (!mirrorState.active) return;
    scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.input);
  };

  addMirrorPaneListener(fromPane, "scroll", onScroll, { passive: true, capture: true });
  addMirrorPaneListener(fromPane, "wheel", onViewportInput, { passive: true });
  addMirrorPaneListener(fromPane, "touchmove", onViewportInput, { passive: true });
  addMirrorPaneListener(fromPane, "touchend", onViewportInput, { passive: true });
  addMirrorPaneListener(fromPane, "keyup", onViewportInput);
}

function addMirrorPaneListener(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  mirrorState.cleanupHandlers.push(() => target.removeEventListener(type, listener, options));
}

function syncMirrorScroll(fromPane, toPane) {
  const anchor = getMirrorScrollAnchor(fromPane);
  const target = anchor ? resolveMirrorAnchorTarget(anchor, toPane) : null;

  beginMirrorScrollSuppression();
  if (target) {
    toPane.scrollTo({ left: target.x, top: target.y, behavior: "auto" });
  } else {
    syncMirrorScrollByRatio(fromPane, toPane);
  }
}

function syncMirrorNestedScroll(fromTarget, fromPane, toPane) {
  if (!(fromTarget instanceof Element) || fromTarget === fromPane || !fromPane.contains(fromTarget)) {
    return false;
  }
  if (!isScrollableMirrorElement(fromTarget)) return false;

  const nodeId = fromTarget.getAttribute(MIRROR_CLONE_NODE_ID_ATTRIBUTE);
  if (!nodeId) return false;

  const toTarget = toPane.querySelector(`[${MIRROR_CLONE_NODE_ID_ATTRIBUTE}="${CSS.escape(nodeId)}"]`);
  if (!(toTarget instanceof Element) || !isScrollableMirrorElement(toTarget)) return false;

  const fromMaxY = getElementMaxScrollY(fromTarget);
  const toMaxY = getElementMaxScrollY(toTarget);
  const fromMaxX = getElementMaxScrollX(fromTarget);
  const toMaxX = getElementMaxScrollX(toTarget);
  if (fromMaxY <= 0 && fromMaxX <= 0) return false;

  beginMirrorScrollSuppression();
  toTarget.scrollTo({
    left: fromMaxX > 0 && toMaxX > 0
      ? clamp(Math.round((fromTarget.scrollLeft / fromMaxX) * toMaxX), 0, toMaxX)
      : toTarget.scrollLeft,
    top: fromMaxY > 0 && toMaxY > 0
      ? clamp(Math.round((fromTarget.scrollTop / fromMaxY) * toMaxY), 0, toMaxY)
      : toTarget.scrollTop,
    behavior: "auto"
  });
  return true;
}

function isScrollableMirrorElement(element) {
  return getElementMaxScrollY(element) > 0 || getElementMaxScrollX(element) > 0;
}

function getElementMaxScrollY(element) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function getElementMaxScrollX(element) {
  return Math.max(0, element.scrollWidth - element.clientWidth);
}

function beginMirrorScrollSuppression() {
  mirrorState.suppressScrollUntil = Date.now() + SPLIT_SCROLL_SUPPRESS_MS;
}

function syncMirrorScrollByRatio(fromPane, toPane) {
  const fromMaxY = getPaneMaxScrollY(fromPane);
  const toMaxY = getPaneMaxScrollY(toPane);
  const ratioY = fromMaxY > 0 ? fromPane.scrollTop / fromMaxY : 0;
  toPane.scrollTo({
    left: toPane.scrollLeft,
    top: clamp(Math.round(ratioY * toMaxY), 0, toMaxY),
    behavior: "auto"
  });
}

function getPaneMaxScrollY(pane) {
  return Math.max(0, pane.scrollHeight - pane.clientHeight);
}

function getMirrorScrollAnchor(pane) {
  const viewportHeight = pane.clientHeight || 0;
  const preferredTop = Math.min(Math.max(80, viewportHeight * 0.18), viewportHeight * 0.45);
  const candidates = [];

  collectMirrorAnchorUnits(pane).forEach((unit) => {
    const rect = getMirrorUnitRectInPane(unit, pane);
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

function resolveMirrorAnchorTarget(anchor, pane) {
  const unit = findMirrorAnchorUnit(pane, anchor.key, anchor.occurrence);
  if (!unit) return null;

  const rect = getMirrorUnitRectInPane(unit, pane);
  if (!rect) return null;

  const maxY = getPaneMaxScrollY(pane);
  return {
    x: pane.scrollLeft || 0,
    y: clamp(Math.round((pane.scrollTop || 0) + rect.top - anchor.viewportTop), 0, maxY)
  };
}

function getMirrorUnitRectInPane(unit, pane) {
  const rect = getTextUnitRect(unit);
  if (!rect) return null;
  const paneRect = pane.getBoundingClientRect();
  return {
    top: rect.top - paneRect.top,
    bottom: rect.bottom - paneRect.top,
    left: rect.left - paneRect.left,
    right: rect.right - paneRect.left,
    width: rect.width,
    height: rect.height
  };
}

function startMirrorViewportWatcher() {
  stopMirrorViewportWatcher();
  mirrorState.lastViewportSignature = getMirrorViewportSignature();
  mirrorState.viewportWatchTimer = window.setInterval(() => {
    if (!mirrorState.active) return;
    const signature = getMirrorViewportSignature();
    if (!signature || signature === mirrorState.lastViewportSignature) return;
    mirrorState.lastViewportSignature = signature;
    scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.retry);
  }, MIRROR_VIEWPORT_WATCH_MS);
}

function stopMirrorViewportWatcher() {
  window.clearInterval(mirrorState.viewportWatchTimer);
  mirrorState.viewportWatchTimer = null;
}

function getMirrorViewportSignature() {
  if (!mirrorState.active || !mirrorState.targetPane) return "";
  return collectMirrorAnchorUnits(mirrorState.targetPane)
    .filter((unit) => isMirrorElementInViewport(unit.element, mirrorState.targetPane))
    .slice(0, 40)
    .map((unit) => `${unit.key}:${unit.occurrence}`)
    .join("|");
}

function scheduleMirrorTranslation(delayMs = MIRROR_TRANSLATION_DELAY_MS.default) {
  window.clearTimeout(mirrorState.translateTimer);
  mirrorState.translateTimer = window.setTimeout(() => {
    translateMirrorViewport({ runId: runtimeState.activeRun }).catch((error) => {
      if (!isContextInvalidatedError(error)) console.warn("Mirror translation failed", error);
    });
  }, delayMs);
}

async function translateMirrorViewport({ runId = runtimeState.activeRun } = {}) {
  if (!mirrorState.active || !mirrorState.targetPane || !isActiveRun(runId)) {
    return { translatedCount: 0, skippedCount: 0 };
  }
  if (mirrorState.isTranslating) {
    mirrorState.needsTranslation = true;
    return { translatedCount: 0, skippedCount: 0 };
  }

  mirrorState.isTranslating = true;
  mirrorState.needsTranslation = false;
  let shouldContinueAfterPass = false;
  let madeProgress = false;
  let followUpDelay = MIRROR_TRANSLATION_DELAY_MS.retry;

  try {
    const allUnits = collectMirrorTextUnits(mirrorState.targetPane, runtimeState.settings);
    const pendingUnits = allUnits.filter((unit) => !isFailedMirrorUnit(unit, runtimeState.settings));
    const units = selectMirrorTranslationUnits(pendingUnits);
    if (units.length === 0) return { translatedCount: 0, skippedCount: 0 };
    shouldContinueAfterPass = pendingUnits.length > units.length;

    mirrorState.lastViewportSignature = getMirrorViewportSignature();
    const { translatedCount: cachedCount, missingGroups } = collectMissingMirrorTranslationGroups(units, runtimeState.settings);
    const { translatedCount: batchCount, failedCount, aborted } = await runTranslationBatches(missingGroups, {
      runId,
      batchSize: MIRROR_TRANSLATION_BATCH_SIZE,
      shouldContinue: () => isActiveRun(runId) && mirrorState.active,
      onBatchError: (batch, message) => markMirrorTranslationFailed(batch, message),
      errorMessage: "Mirror translation failed",
      applyTranslation: (group, translation) => {
        const normalizedTranslation = String(translation);
        mirrorState.translationCache.set(group.key, normalizedTranslation);
        mirrorState.failedTranslationKeys.delete(group.key);
        return replaceMirrorTextUnits(group.units, normalizedTranslation);
      }
    });

    const nextTranslatedCount = cachedCount + batchCount;
    if (aborted && nextTranslatedCount > 0) {
      shouldContinueAfterPass = true;
      followUpDelay = MIRROR_TRANSLATION_DELAY_MS.errorRetry;
    }
    madeProgress = nextTranslatedCount > 0 || (failedCount > 0 && !aborted);
    return { translatedCount: nextTranslatedCount, skippedCount: units.length - nextTranslatedCount };
  } finally {
    mirrorState.isTranslating = false;
    if ((mirrorState.needsTranslation || (shouldContinueAfterPass && madeProgress)) && mirrorState.active && isActiveRun(runId)) {
      mirrorState.needsTranslation = false;
      scheduleMirrorTranslation(followUpDelay);
    }
  }
}

function selectMirrorTranslationUnits(units) {
  return units.slice(0, MIRROR_TRANSLATION_UNIT_LIMIT);
}

function isFailedMirrorUnit(unit, currentSettings) {
  return mirrorState.failedTranslationKeys.has(translationCacheKey(unit.text, currentSettings));
}

function markMirrorTranslationFailed(groups, message) {
  const retryable = shouldStopAfterBatchError(message);
  groups.forEach((group) => {
    if (group?.key && !retryable) mirrorState.failedTranslationKeys.add(group.key);
    group?.units?.forEach((unit) => {
      unit.element.classList?.remove("bit-pending");
      if (!retryable) {
        unit.element.classList?.add("bit-failed");
        unit.element.dataset.bitError = message;
        addMirrorRetranslateButton(unit.element);
      }
    });
  });
}

// Mirror translates one unit per *block* (paragraph/heading/list-item), not per text
// node, so inline emphasis (<sup>, <strong>, per-word <span>) can't fragment a sentence
// into separately-translated pieces. Anchors stay per-text-node, so scroll-sync is intact.
const MIRROR_BLOCK_SELECTOR =
  "p, li, blockquote, h1, h2, h3, h4, h5, h6, summary, figcaption, caption, dt, dd, td, th, legend, [role='heading'], [role='listitem']";
const MIRROR_INLINE_TAGS = new Set([
  "SPAN", "A", "STRONG", "EM", "B", "I", "SMALL", "TIME", "MARK", "SUP", "SUB",
  "CODE", "KBD", "ABBR", "CITE", "Q", "U", "S", "WBR", "BDI", "BDO", "DFN", "VAR",
  "SAMP", "INS", "DEL", "LABEL", "BUTTON", "FONT"
]);

function collectMirrorTextUnits(root, currentSettings) {
  const seenBlocks = new Set();
  const units = [];
  if (!root?.ownerDocument?.defaultView) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isTranslatableMirrorTextNode(node, currentSettings)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  while (walker.nextNode()) {
    const block = findMirrorBlock(walker.currentNode.parentElement, root);
    if (!block || seenBlocks.has(block)) continue;
    seenBlocks.add(block);
    const textNodes = collectMirrorBlockTextNodes(block);
    if (textNodes.length === 0) continue;
    const blockUnits = createMirrorBlockTranslationUnits(block, textNodes);
    if (blockUnits.length > 0) units.push(...blockUnits);
  }

  return units;
}

function createMirrorBlockTranslationUnits(element, textNodes) {
  const text = normalizeText(textNodes.map((node) => node.nodeValue || "").join(""));
  if (isTranslatableText(text)) return [{ element, textNodes, text }];
  if (text.length <= MAX_TRANSLATION_TEXT_LENGTH) return [];

  return splitMirrorTextNodesIntoUnits(element, expandLongMirrorTextNodes(textNodes));
}

function splitMirrorTextNodesIntoUnits(element, textNodes) {
  const units = [];
  let currentNodes = [];
  let currentParts = [];

  const flush = () => {
    const text = normalizeText(currentParts.join(""));
    if (isTranslatableText(text)) units.push({ element, textNodes: currentNodes, text });
    currentNodes = [];
    currentParts = [];
  };

  textNodes.forEach((node) => {
    const value = node.nodeValue || "";
    const nextText = normalizeText(currentParts.concat(value).join(""));
    if (currentNodes.length > 0 && nextText.length > MAX_TRANSLATION_TEXT_LENGTH) {
      flush();
    }
    currentNodes.push(node);
    currentParts.push(value);
  });

  flush();
  return units;
}

function expandLongMirrorTextNodes(textNodes) {
  return textNodes.flatMap((node) => splitLongMirrorTextNode(node));
}

function splitLongMirrorTextNode(node) {
  const value = node.nodeValue || "";
  if (normalizeText(value).length <= MAX_TRANSLATION_TEXT_LENGTH) return [node];

  const parts = splitLongMirrorTextValue(value);
  if (parts.length <= 1) return [node];

  const newNodes = parts.map((part) => node.ownerDocument.createTextNode(part));
  node.replaceWith(...newNodes);
  return newNodes;
}

function splitLongMirrorTextValue(value) {
  const parts = [];
  let remaining = value;

  while (normalizeText(remaining).length > MAX_TRANSLATION_TEXT_LENGTH) {
    let splitAt = remaining.lastIndexOf(" ", MAX_TRANSLATION_TEXT_LENGTH);
    if (splitAt < MAX_TRANSLATION_TEXT_LENGTH * 0.5) splitAt = MAX_TRANSLATION_TEXT_LENGTH;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) parts.push(remaining);
  return parts;
}

function findMirrorBlock(element, root) {
  if (!element || !root.contains(element)) return null;

  const semantic = element.closest(MIRROR_BLOCK_SELECTOR);
  if (semantic && root.contains(semantic)) return semantic;

  let current = element;
  while (current && current !== root) {
    if (isBlockLevelElement(current)) return current;
    current = current.parentElement;
  }

  return element;
}

function isBlockLevelElement(element) {
  if (MIRROR_INLINE_TAGS.has(element.tagName)) return false;
  const display = window.getComputedStyle(element).display;
  return (
    display === "block" ||
    display === "flex" ||
    display === "grid" ||
    display === "list-item" ||
    display === "table" ||
    display === "table-cell" ||
    display === "flow-root"
  );
}

function isMirrorBlockBoundary(element) {
  return element.matches(MIRROR_BLOCK_SELECTOR) || isBlockLevelElement(element);
}

// All text nodes that belong directly to `block` (descending through inline elements but
// stopping at nested blocks, so a paragraph's text isn't merged with a child list/table).
function collectMirrorBlockTextNodes(block) {
  const textNodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (node === block) return NodeFilter.FILTER_SKIP;
      if (node.matches(EXCLUDED_SELECTOR) || isMirrorBlockBoundary(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    }
  });

  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === Node.TEXT_NODE) textNodes.push(walker.currentNode);
  }

  return textNodes;
}

function collectMirrorAnchorUnits(root) {
  const units = [];
  if (!root?.ownerDocument?.defaultView) return units;

  const occurrenceByKey = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!isMirrorAnchorTextNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const unit = createMirrorAnchorUnit(walker.currentNode, occurrenceByKey);
    if (unit) units.push(unit);
  }

  return units;
}

function findMirrorAnchorUnit(root, key, occurrence) {
  return collectMirrorAnchorUnits(root).find((unit) => (
    unit.key === key && unit.occurrence === occurrence
  )) || null;
}

function isTranslatableMirrorTextNode(node, currentSettings) {
  if (mirrorState.textReplacements.has(node)) return false;

  const text = normalizeText(node.nodeValue || "");
  if (!isTranslatableText(text)) return false;
  if (shouldSkipTranslatedText(text, currentSettings)) return false;
  if (!isValidMirrorTextParent(node.parentElement)) return false;

  return true;
}

function isMirrorAnchorTextNode(node) {
  const text = getMirrorOriginalTextNodeText(node);
  if (!isTranslatableText(text)) return false;
  return isValidMirrorTextParent(node.parentElement);
}

function isValidMirrorTextParent(parent) {
  if (!parent || parent.closest(EXCLUDED_SELECTOR)) return false;

  const style = window.getComputedStyle(parent);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }

  return true;
}

function isMirrorElementInViewport(element, pane) {
  if (!element || !pane) return false;
  const rects = Array.from(element.getClientRects()).filter((rect) => rect.width >= 1 && rect.height >= 1);
  if (rects.length === 0) return false;

  const paneRect = pane.getBoundingClientRect();
  const verticalPadding = paneRect.height * 0.2;

  return rects.some((rect) => (
    rect.bottom >= paneRect.top - verticalPadding &&
    rect.top <= paneRect.bottom + verticalPadding &&
    rect.right >= paneRect.left &&
    rect.left <= paneRect.right &&
    !isClippedByMirrorAncestor(element, rect, pane)
  ));
}

function isClippedByMirrorAncestor(element, rect, pane) {
  const elementPosition = window.getComputedStyle(element).position;
  if (elementPosition === "fixed") return false;

  let current = element.parentElement;
  while (current && current !== pane) {
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

function createMirrorAnchorUnit(textNode, occurrenceByKey) {
  const element = textNode.parentElement;
  if (!element) return null;

  const text = getMirrorOriginalTextNodeText(textNode);
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

function getMirrorOriginalTextNodeText(textNode) {
  const replacement = mirrorState.textReplacements.get(textNode);
  return normalizeText(replacement?.originalText || textNode.nodeValue || "");
}

function collectMissingMirrorTranslationGroups(units, currentSettings) {
  let translatedCount = 0;
  const missingGroups = [];
  const groups = groupDuplicateTextItems(units, {
    bucketName: "units",
    getKey: (unit) => translationCacheKey(unit.text, currentSettings),
    getText: (unit) => unit.text
  });

  groups.forEach((group) => {
    const cachedTranslation = mirrorState.translationCache.get(group.key);
    if (cachedTranslation) {
      translatedCount += replaceMirrorTextUnits(group.units, cachedTranslation);
      return;
    }

    missingGroups.push(group);
  });

  return { translatedCount, missingGroups };
}

function replaceMirrorTextUnits(units, translation) {
  return units.reduce((count, unit) => (
    replaceMirrorTextUnit(unit, translation) ? count + 1 : count
  ), 0);
}

// Put the whole block translation into its first text node and clear the rest, so inline
// pieces (<sup>er</sup>, per-word spans) stop showing untranslated leftovers. Every text
// node keeps its stored original, so the per-text-node scroll-sync anchors still match.
function replaceMirrorTextUnit(unit, translation) {
  const textNodes = unit.textNodes || [];
  const primary = textNodes[0];
  if (!primary?.isConnected || mirrorState.textReplacements.has(primary)) return false;

  const currentText = normalizeText(textNodes.map((node) => node.nodeValue || "").join(""));
  if (currentText !== unit.text) return false;

  const normalizedTranslation = String(translation || "").trim();
  textNodes.forEach((node, index) => {
    if (!node.isConnected || mirrorState.textReplacements.has(node)) return;
    const originalText = node.nodeValue || "";
    const translatedText = index === 0 ? preserveTextNodeSpacing(originalText, normalizedTranslation) : "";
    mirrorState.textReplacements.set(node, { originalText, translatedText });
    node.nodeValue = translatedText;
  });
  unit.element.classList?.remove("bit-pending", "bit-failed");
  unit.element.removeAttribute?.("data-bit-error");
  unit.element.classList?.add("bit-mirror-translated-text");
  addMirrorRetranslateButton(unit.element);
  return true;
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
  if (mirrorState.active) {
    scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.input);
    return;
  }
  if (
    runtimeState.contextAlive &&
    runtimeState.settings.enabled &&
    runtimeState.settings.translateScope === "viewport"
  ) {
    scheduleAutoTranslate();
  }
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
  startContentObserver();
}

function stopAutoMode() {
  window.clearTimeout(runtimeState.autoTranslateTimer);
  runtimeState.autoTranslateTimer = null;
  runtimeState.autoTranslatePending = false;
  stopContentObserver();
}

// Lazy-loaded / async-injected content can enter the viewport without ever
// firing a scroll or resize event, leaving it untranslated. Watch the DOM for
// page-content changes and re-run the viewport pass when they happen.
function startContentObserver() {
  if (runtimeState.contentObserver || typeof MutationObserver !== "function" || !document.body) return;
  const observer = new MutationObserver((mutations) => {
    if (!runtimeState.contextAlive || mirrorState.active) return;
    if (mutations.some(isPageContentMutation)) handlePossibleViewportChange();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  runtimeState.contentObserver = observer;
}

function stopContentObserver() {
  runtimeState.contentObserver?.disconnect();
  runtimeState.contentObserver = null;
}

// Ignore the mutations we cause ourselves (inserting/removing translation
// nodes, swapping replaced text) so the observer doesn't retrigger in a loop.
function isPageContentMutation(mutation) {
  if (isOwnTranslationNode(mutation.target)) return false;
  const changed = [...mutation.addedNodes, ...mutation.removedNodes];
  if (changed.length === 0) return false;
  return changed.some((node) => !isOwnTranslationNode(node));
}

function isOwnTranslationNode(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(element?.closest?.(".bit-translation, .bit-retranslate, .bit-replaced, .bit-mirror-root"));
}

async function translateVisibleIfEnabled() {
  if (!runtimeState.contextAlive || !runtimeState.settings.enabled) return;
  if (mirrorState.active) {
    scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.retry);
    return;
  }
  if (runtimeState.isAutoTranslating) {
    // A viewport change arrived mid-flight; remember it and re-run once the in-flight
    // pass finishes so the newly scrolled-in content isn't silently dropped.
    runtimeState.autoTranslatePending = true;
    return;
  }
  const signature = getViewportSignature();
  if (signature && signature === runtimeState.lastViewportSignature) return;
  runtimeState.isAutoTranslating = true;
  let translatedOk = false;
  try {
    const result = await translatePage({ ...runtimeState.settings, translateScope: "viewport", enabled: true, auto: true });
    translatedOk = !result?.failedCount;
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.warn("Auto translation failed", error);
    }
  } finally {
    runtimeState.isAutoTranslating = false;
    // Commit the signature only on success so a failed pass retries on the next trigger.
    if (translatedOk) runtimeState.lastViewportSignature = signature;
    if (runtimeState.autoTranslatePending) {
      runtimeState.autoTranslatePending = false;
      scheduleAutoTranslate();
    }
  }
}

function getViewportSignature() {
  const blocks = collectBlocks({
    ...runtimeState.settings,
    translateScope: "viewport",
    viewMode: runtimeState.settings.viewMode
  });
  return `${blocks.length}|` + blocks
    .slice(0, 24)
    .map((item) => `${ensureBlockId(item.element)}:${item.text.slice(0, 80)}`)
    .join("|");
}

function translationCacheKey(text, currentSettings) {
  return [
    currentSettings.provider || DEFAULT_SETTINGS.provider,
    currentSettings.sourceLang || DEFAULT_SETTINGS.sourceLang,
    currentSettings.targetLang || DEFAULT_SETTINGS.targetLang,
    text
  ].join("\u0000");
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

  if (bitDebugEnabled()) logCollectDiagnostics(currentSettings, blocks.length);
  return blocks;
}

function bitDebugEnabled() {
  try {
    return Boolean(window.localStorage?.getItem("bitDebug"));
  } catch {
    return false;
  }
}

// Diagnostics: for each block candidate, report the first gate it fails so we
// can see *why* a region (e.g. the article body) isn't being translated.
// Enable by running `localStorage.bitDebug = '1'` in the page console, then
// translate. Also exposed as `window.__bitDiagnose()` for an on-demand run.
function rejectionReason(element, currentSettings) {
  if (element.closest(EXCLUDED_SELECTOR)) return "excluded-selector";
  if (hasTranslatableAncestor(element)) return "has-translatable-ancestor";
  const rect = element.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 8) return "too-small";
  if (!isElementVisible(element)) return "invisible";
  const text = getElementText(element);
  if (text.length > MAX_TRANSLATION_TEXT_LENGTH && !isNaturallyTextBlock(element)) return "too-long";
  if (currentSettings.translateScope === "viewport" && !isElementInViewport(element)) return "out-of-viewport";
  if (!isTranslatableBlockText(text)) return "non-translatable-text";
  if (element.dataset.bitTranslatedText === text) return "already-translated";
  if (shouldSkipTranslatedText(text, currentSettings)) return "skipped-korean";
  return null;
}

function logCollectDiagnostics(currentSettings, passedCount) {
  const counts = {};
  const samples = {};
  const seen = new Set();
  for (const element of collectBlockCandidates()) {
    if (seen.has(element)) continue;
    seen.add(element);
    const reason = rejectionReason(element, currentSettings) || "PASS";
    counts[reason] = (counts[reason] || 0) + 1;
    if (reason !== "PASS" && (samples[reason] = samples[reason] || []).length < 4) {
      samples[reason].push(element);
    }
  }
  console.log(`[BIT] collect: ${passedCount} translatable / ${seen.size} candidates`, counts);
  console.log("[BIT] rejected samples (expand to inspect elements)", samples);
}

if (typeof window !== "undefined") {
  window.__bitDiagnose = () => logCollectDiagnostics(
    { ...runtimeState.settings, translateScope: runtimeState.settings.translateScope },
    -1
  );
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
  if (!isTranslatableBlockText(text)) return null;
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
  return normalizeTranslationBatchSize(currentSettings.batchSize);
}

function normalizeTranslationBatchSize(value) {
  return clamp(Number(value) || DEFAULT_SETTINGS.batchSize, 1, MAX_TRANSLATION_BATCH_SIZE);
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
      if (isStandaloneUrlLikeText(text)) return NodeFilter.FILTER_REJECT;
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

  const range = textNode.ownerDocument.createRange();
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
  return Boolean(currentSettings.skipTranslated) && looksMostlyTargetLanguage(text, currentSettings.targetLang);
}

function getTextContainer(element) {
  const semanticContainer = element.closest(TEXT_CONTAINER_SELECTOR);
  if (semanticContainer) return semanticContainer;

  const inlineSentenceContainer = findInlineSentenceContainer(element);
  if (inlineSentenceContainer) return inlineSentenceContainer;

  let current = element;
  while (current && current !== document.body) {
    if (current.closest(EXCLUDED_SELECTOR)) return null;
    if (isStandaloneTextContainer(current)) return current;
    current = current.parentElement;
  }

  return element;
}

const BLOCK_SENTENCE_TAGS = ["DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE"];

function getDirectText(element) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => normalizeText(node.nodeValue || ""))
    .join(" ")
    .trim();
}

function isStandaloneTextContainer(element) {
  const tag = element.tagName;
  if (["A", "SPAN", "STRONG", "EM", "B", "I", "SMALL", "TIME", "MARK"].includes(tag)) {
    return true;
  }

  if (!BLOCK_SENTENCE_TAGS.includes(tag)) {
    return false;
  }

  return getDirectText(element).length >= 8;
}

// A non-semantic block (e.g. <div>) that carries its own sentence text directly —
// used to absorb inline links/emphasis into the surrounding sentence rather than
// letting them fragment into standalone word-level translation units.
function hasOwnSentenceText(element) {
  return BLOCK_SENTENCE_TAGS.includes(element.tagName) && getDirectText(element).length >= 8;
}

function isInlineTextElement(element) {
  return element.matches("a, button, span[data-as='p'], strong, em, b, i, small, time, mark, [role='link'], [role='button']");
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
  if (text.length > MAX_TRANSLATION_TEXT_LENGTH && !isNaturallyTextBlock(element)) return false;

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
  const inlineCandidate = isInlineTextElement(element);
  let current = element.parentElement;
  while (current && current !== document.body) {
    if (current.classList?.contains("bit-translation")) return true;
    if (current.matches?.(TEXT_CONTAINER_SELECTOR) && !isNestedListItem(element, current)) return true;
    // Inline link/emphasis embedded in a non-semantic sentence block → absorb into that
    // block so the sentence stays one unit instead of fragmenting into words.
    if (
      inlineCandidate &&
      (hasOwnSentenceText(current) || isInlineSentenceContainer(current)) &&
      !isNestedListItem(element, current)
    ) {
      return true;
    }
    const currentText = normalizeText(current.innerText || current.textContent || "");
    if (
      currentText.length >= 12 &&
      currentText.length <= MAX_TRANSLATION_TEXT_LENGTH &&
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
  if (text.length < 2 || text.length > MAX_TRANSLATION_TEXT_LENGTH) return false;
  if (!/[A-Za-z0-9\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/.test(text)) return false;
  if (/^[\d\s.,:;!?()[\]{}'"`~@#$%^&*+=|\\/<>-]+$/.test(text)) return false;
  return true;
}

function isTranslatableText(text) {
  return isUsefulText(text) && !isStandaloneUrlLikeText(text);
}

function isTranslatableBlockText(text) {
  // Validate a prefix for very long blocks; otherwise a single >3000-char paragraph would
  // be dropped before provider-side limits get a chance to handle it.
  return isUsefulText(getTranslationTextSample(text)) && !isStandaloneUrlLikeText(text);
}

function getTranslationTextSample(text) {
  return text.length > MAX_TRANSLATION_TEXT_LENGTH ? text.slice(0, MAX_TRANSLATION_TEXT_LENGTH) : text;
}

function findInlineSentenceContainer(element) {
  let current = element?.parentElement;
  while (current && current !== document.body) {
    if (current.closest(EXCLUDED_SELECTOR)) return null;
    if (isInlineSentenceContainer(current)) return current;
    current = current.parentElement;
  }
  return null;
}

function isInlineSentenceContainer(element) {
  if (!BLOCK_SENTENCE_TAGS.includes(element.tagName)) return false;
  if (!hasOnlyInlineSentenceChildren(element)) return false;

  const text = normalizeText(element.innerText || element.textContent || "");
  if (text.length < 8 || text.length > MAX_TRANSLATION_TEXT_LENGTH) return false;
  return isTranslatableText(text);
}

function hasOnlyInlineSentenceChildren(element) {
  const children = Array.from(element.children).filter((child) => !child.matches(EXCLUDED_SELECTOR));
  return children.length > 0 && children.every(isInlineSentenceChild);
}

function isInlineSentenceChild(element) {
  if (!INLINE_SENTENCE_TAGS.has(element.tagName) && element.getAttribute("role") !== "link") return false;
  return Array.from(element.children).every(isInlineSentenceChild);
}

function isStandaloneUrlLikeText(text) {
  const tokens = String(text || "")
    .split(/\s+/)
    .map(stripUrlTokenPunctuation)
    .filter(Boolean);

  return tokens.length > 0 && tokens.every(isUrlLikeToken);
}

function stripUrlTokenPunctuation(token) {
  return token.replace(/^[<([{"'`]+|[>)\]},"'`.;!?]+$/g, "");
}

function isUrlLikeToken(token) {
  if (/^(?:https?|ftp):\/\/[^\s]+$/i.test(token)) return true;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(token)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(token)) return true;
  if (/^www\.[^\s]+\.[^\s]+$/i.test(token)) return true;
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s]*)?$/i.test(token);
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
  removeTranslationNodesForSourceId(sourceId);

  if (displayMode === "replace") {
    if (element.classList.contains("bit-replaced")) return;
    // Keep a text fallback in the DOM (survives a content-script re-injection that drops the
    // WeakMap) and stash the real nodes so markup can be restored without loss.
    element.dataset.bitOriginalText = element.textContent || "";
    const originalNodes = document.createDocumentFragment();
    while (element.firstChild) originalNodes.appendChild(element.firstChild);
    replacedOriginalNodes.set(element, originalNodes);
    element.classList.add("bit-replaced");
    element.textContent = translation;
    return;
  }

  const translationNode = createTranslationNode(translation);
  translationNode.dataset.bitSourceId = sourceId;
  insertTranslationNode(element, translationNode);
}

function removeTranslationNodesForSourceId(sourceId) {
  document
    .querySelectorAll(`.bit-translation[data-bit-source-id="${CSS.escape(sourceId)}"]`)
    .forEach((node) => node.remove());
}

function insertTranslationNode(element, translationNode) {
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

function renderFailure(element, message) {
  const sourceId = ensureBlockId(element);
  removeTranslationNodesForSourceId(sourceId);

  const failureNode = createFailureNode(message);
  failureNode.dataset.bitSourceId = sourceId;
  insertTranslationNode(element, failureNode);
}

function createTranslationNode(translation) {
  const translationNode = document.createElement("div");
  translationNode.className = "bit-translation";
  translationNode.dir = "auto";

  const textNode = document.createElement("span");
  textNode.className = "bit-translation-text";
  textNode.textContent = translation;
  translationNode.appendChild(textNode);
  translationNode.appendChild(createRetranslateButton());

  return translationNode;
}

function createFailureNode(message) {
  const failureNode = document.createElement("div");
  failureNode.className = "bit-translation bit-translation-failed";
  failureNode.dir = "auto";
  if (message) failureNode.title = message;

  const textNode = document.createElement("span");
  textNode.className = "bit-translation-text";
  textNode.textContent = "번역 실패";
  failureNode.appendChild(textNode);
  failureNode.appendChild(createRetranslateButton("다시 시도"));

  return failureNode;
}

function createRetranslateButton(label = "↻") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "bit-retranslate";
  button.title = "이 문단 다시 번역";
  button.setAttribute("aria-label", "이 문단 다시 번역");
  button.textContent = label;
  return button;
}

// Re-translate a single block on demand (the ↻ shown on each translation). It re-requests
// just that block as a one-item batch with the same engine — which also sidesteps the batch
// JSON misalignment that makes weak LLMs echo/garble items, so a lone retry often succeeds
// where the original batch didn't.
function handleRetranslateClick(event) {
  const button = event.target?.closest?.(".bit-retranslate");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  if (button.classList.contains("bit-retranslate-mirror")) {
    if (button.parentElement) retranslateMirrorBlock(button.parentElement);
    return;
  }

  const sourceId = button.closest(".bit-translation")?.dataset.bitSourceId;
  const element = sourceId
    ? document.querySelector(`[data-bit-block-id="${CSS.escape(sourceId)}"]`)
    : null;
  if (!element) return;

  retranslateBlock(element).catch((error) => {
    if (!isContextInvalidatedError(error)) console.warn("Re-translation failed", error);
  });
}

async function retranslateBlock(element) {
  if (!runtimeState.contextAlive || !element?.isConnected) return;

  removeBlockTranslation(element);
  const text = getElementText(element);
  if (!isTranslatableBlockText(text)) return;

  const runId = runtimeState.activeRun;
  markPending([{ element }]);

  const { translatedCount } = await runTranslationBatches([{ key: text, text, blocks: [{ element }] }], {
    runId,
    batchSize: 1,
    onBatchError: (batch, message) => markFailed(batch.flatMap((group) => group.blocks), message),
    applyTranslation: (group, translation) => {
      group.blocks.forEach((item) => renderTranslation(item.element, translation, runtimeState.settings.displayMode));
      return group.blocks.length;
    }
  });

  // Provider echoed again (translation dropped to null) — surface that rather than leaving a stuck spinner.
  if (translatedCount === 0) markFailed([{ element }], "다시 번역했지만 번역 결과를 받지 못했습니다.");
}

function removeBlockTranslation(element) {
  const sourceId = element.dataset.bitBlockId;
  if (sourceId) {
    document
      .querySelectorAll(`.bit-translation[data-bit-source-id="${CSS.escape(sourceId)}"]`)
      .forEach((node) => node.remove());
  }
  element.classList.remove("bit-pending", "bit-failed");
  element.removeAttribute("data-bit-error");
  delete element.dataset.bitTranslatedText;
  restoreReplacedElement(element);
}

// Undo a "replace" render: put the original child nodes back (preferred, lossless) or fall
// back to the stored text if the nodes are gone (e.g. after a content-script re-injection).
function restoreReplacedElement(element) {
  if (!element.classList.contains("bit-replaced")) return;

  const originalNodes = replacedOriginalNodes.get(element);
  if (originalNodes) {
    element.textContent = "";
    element.appendChild(originalNodes);
    replacedOriginalNodes.delete(element);
  } else if (element.dataset.bitOriginalText) {
    element.textContent = element.dataset.bitOriginalText;
  }
  element.classList.remove("bit-replaced");
  delete element.dataset.bitOriginalText;
}

function addMirrorRetranslateButton(block) {
  if (!block || block.querySelector(":scope > .bit-retranslate")) return;
  const button = createRetranslateButton();
  button.classList.add("bit-retranslate-mirror");
  block.appendChild(button);
}

// Split-view re-translate: the translation lives inside the cloned block's text nodes, so we
// restore the block to its original text, forget its cached/failed translations, then let the
// normal mirror pass pick it back up — now untranslated, and effectively a one-item request.
function retranslateMirrorBlock(block) {
  if (!mirrorState.active || !block?.isConnected) return;
  restoreMirrorBlockToOriginal(block);
  scheduleMirrorTranslation(MIRROR_TRANSLATION_DELAY_MS.immediate);
}

function restoreMirrorBlockToOriginal(block) {
  block.querySelector(":scope > .bit-retranslate")?.remove();
  block.classList.remove("bit-mirror-translated-text", "bit-pending", "bit-failed");
  block.removeAttribute("data-bit-error");

  collectMirrorBlockTextNodes(block).forEach((node) => {
    const replacement = mirrorState.textReplacements.get(node);
    if (replacement) {
      node.nodeValue = replacement.originalText;
      mirrorState.textReplacements.delete(node);
    }
  });

  // Drop cached/failed translations for every unit in the block so the next pass re-fetches
  // instead of re-applying the same cached (bad) result.
  createMirrorBlockTranslationUnits(block, collectMirrorBlockTextNodes(block)).forEach((unit) => {
    const key = translationCacheKey(unit.text, runtimeState.settings);
    mirrorState.translationCache.delete(key);
    mirrorState.failedTranslationKeys.delete(key);
  });
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
    // Keep any existing translation visible until the new one is ready —
    // renderTranslation swaps it out atomically. Removing it here left the
    // block blank whenever the run was cancelled (e.g. on scroll) or the
    // batch failed before the replacement arrived.
  });
}

function clearPending(batch) {
  batch.forEach(({ element }) => {
    element.classList.remove("bit-pending");
  });
}

function markTranslationBatchError(batch, message, { quiet = false } = {}) {
  const blocks = batch.flatMap((group) => group.blocks);
  if (quiet || shouldStopAfterBatchError(message)) {
    clearPending(blocks);
    return;
  }

  markFailed(blocks, message);
}

function markFailed(batch, message) {
  batch.forEach(({ element }) => {
    element.classList.remove("bit-pending");
    element.classList.add("bit-failed");
    element.dataset.bitError = message;
    renderFailure(element, message);
  });
}

function clearTranslations(options = {}) {
  runtimeState.lastViewportSignature = "";
  if (!options.keepMirror) stopMirrorMode();
  document.querySelectorAll(".bit-translation").forEach((node) => node.remove());
  document.querySelectorAll(".bit-pending, .bit-failed").forEach((node) => {
    node.classList.remove("bit-pending", "bit-failed");
    node.removeAttribute("data-bit-error");
  });
  document.querySelectorAll("[data-bit-translated-text]").forEach((node) => {
    delete node.dataset.bitTranslatedText;
  });
  document.querySelectorAll(".bit-replaced").forEach(restoreReplacedElement);
}

function stopMirrorMode() {
  if (!mirrorState.active && !mirrorState.root) return;

  const originalOverflow = mirrorState.originalOverflow;
  const originalBodyOverflow = mirrorState.originalBodyOverflow;

  window.clearTimeout(mirrorState.translateTimer);
  mirrorState.translateTimer = null;
  stopMirrorViewportWatcher();

  while (mirrorState.cleanupHandlers.length > 0) {
    const cleanup = mirrorState.cleanupHandlers.pop();
    try {
      cleanup();
    } catch {
      // Best effort cleanup for split-pane listeners.
    }
  }

  mirrorState.root?.remove();
  resetMirrorState();

  restoreMirrorPageOverflow(originalOverflow, originalBodyOverflow);
}

function resetMirrorState() {
  mirrorState.active = false;
  mirrorState.scrollSyncEnabled = true;
  mirrorState.root = null;
  mirrorState.sourcePane = null;
  mirrorState.targetPane = null;
  mirrorState.suppressScrollUntil = 0;
  mirrorState.isTranslating = false;
  mirrorState.needsTranslation = false;
  mirrorState.lastViewportSignature = "";
  mirrorState.translationCache.clear();
  mirrorState.textReplacements.clear();
  mirrorState.failedTranslationKeys.clear();
  mirrorState.originalOverflow = "";
  mirrorState.originalBodyOverflow = "";
}

function restoreMirrorPageOverflow(
  originalOverflow = mirrorState.originalOverflow,
  originalBodyOverflow = mirrorState.originalBodyOverflow
) {
  document.documentElement.style.overflow = originalOverflow;
  document.body.style.overflow = originalBodyOverflow;
}

function pickRuntimeOptions(currentSettings) {
  const allowed = ["targetLang", "sourceLang", "viewMode", "displayMode", "translateScope", "skipTranslated", "batchSize", "provider"];
  return Object.fromEntries(Object.entries(currentSettings).filter(([key]) => allowed.includes(key)));
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

// Per-target script ranges used to recognise text that is *already* in the target language so
// the "skip already-translated" option works for every CJK target, not just Korean. Latin-script
// targets (en/es/fr/de) share an alphabet and can't be told apart this way, so they're omitted
// (skip simply does nothing for them, as before for non-Korean).
const TARGET_LANGUAGE_SCRIPT_PATTERNS = {
  ko: /[\uac00-\ud7af]/g,
  ja: /[\u3040-\u30ff\u3400-\u9fff]/g,
  "zh-CN": /[\u3400-\u9fff]/g,
  "zh-TW": /[\u3400-\u9fff]/g
};

function looksMostlyTargetLanguage(value, targetLang) {
  const pattern = TARGET_LANGUAGE_SCRIPT_PATTERNS[targetLang];
  if (!pattern) return false;
  const targetChars = (value.match(pattern) || []).length;
  const letters = (value.match(/[A-Za-z\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  return letters > 0 && targetChars / letters > 0.45;
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

    // The MV3 service worker can be recycled mid-request, closing the channel before it
    // answers ("message channel closed before a response was received"). That's transient:
    // abort this pass quietly so the next viewport trigger retries, instead of throwing a
    // scary error from auto-translation.
    if (isRuntimeMessageClosedError(error)) return null;

    if (optional) return null;
    throw error;
  }
}

function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (error) {
    if (!isContextInvalidatedError(error) && !isRuntimeMessageClosedError(error)) throw error;
  }
}

function disableRuntime() {
  runtimeState.contextAlive = false;
  stopTranslationRuntime();
}

function stopTranslationRuntime() {
  runtimeState.settings.enabled = false;
  stopAutoMode();
  stopMirrorMode();
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
  return text.includes("Extension context invalidated") || text.includes("context invalidated");
}

function isRuntimeMessageClosedError(error) {
  const text = error?.message || String(error || "");
  return (
    text.includes("message channel closed") ||
    text.includes("message port closed") ||
    text.includes("Receiving end does not exist")
  );
}
})();
