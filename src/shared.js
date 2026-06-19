(() => {
  // Cross-context helpers. Like defaults.js, this file is loaded *first* into every
  // execution context (background via importScripts, content script + popup + options via
  // manifest/script tags) and exposes its helpers as bare globals on `globalThis`, so the
  // four separate JS realms don't each keep their own copy.
  //
  // Most helpers are pure, but a few touch `chrome.*` or the DOM — those are only *called*
  // from the contexts where those APIs exist (e.g. injectTranslatorContentScript runs in
  // background/popup, never in a content script). Defining them everywhere is harmless because
  // the body only references those globals when invoked.

  const SUPPORTED_PAGE_URL = /^(https?|file):\/\//i;
  const TRANSIENT_EXTENSION_ERROR_MARKERS = [
    "Extension context invalidated",
    "Receiving end does not exist",
    "message channel closed",
    "message port closed"
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function isSupportedPageUrl(url) {
    return SUPPORTED_PAGE_URL.test(String(url || ""));
  }

  function isTransientExtensionError(error) {
    const text = error?.message || String(error || "");
    return TRANSIENT_EXTENSION_ERROR_MARKERS.some((marker) => text.includes(marker));
  }

  // OpenAI-compatible endpoints must be HTTPS, credential-free, and end in /chat/completions.
  // Returns the parsed URL when allowed (callers reuse it, e.g. to read the hostname) or null.
  function parseAllowedOpenAICompatibleEndpoint(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return null;
      if (url.username || url.password) return null;
      if (!url.pathname.endsWith("/chat/completions")) return null;
      return url;
    } catch {
      return null;
    }
  }

  function isAllowedOpenAICompatibleEndpoint(value) {
    return parseAllowedOpenAICompatibleEndpoint(value) !== null;
  }

  // Inject the translator's CSS + scripts into a tab (used by the popup and the keyboard-shortcut
  // path in the background). The script/CSS file list lives here so it can't drift between the
  // two call sites — keep it in sync with manifest.json's content_scripts entry.
  async function injectTranslatorContentScript(tabId, { unsupportedUrlMessage = "현재 페이지에서 실행할 수 없습니다." } = {}) {
    const tab = await chrome.tabs.get(tabId);
    if (!isSupportedPageUrl(tab?.url)) {
      throw new Error(unsupportedUrlMessage);
    }

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/defaults.js", "src/shared.js", "src/content.js"]
    });
  }

  // Ensure host permission for a custom OpenAI-compatible endpoint (popup + options). The caller
  // resolves the endpoint its own way (popup reads storage, options reads the form) and supplies
  // its localized messages; the validation + permission request flow lives here once.
  async function ensureOpenAICompatibleEndpointPermission(endpoint, { invalidMessage, deniedMessage } = {}) {
    const url = parseAllowedOpenAICompatibleEndpoint(endpoint);
    if (!url) throw new Error(invalidMessage);
    if (url.hostname === "api.openai.com") return;

    const origin = `${url.origin}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return;

    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) throw new Error(deniedMessage);
  }

  // Send a message to a tab's content script; if the script isn't there yet (a transient
  // "receiving end"/"context invalidated" error), inject it once and retry. `inject` lets the
  // caller supply its own injection wrapper (e.g. one with localized error messages), and
  // `retryFailureMessage`, when set, converts a still-transient failure after injection into a
  // friendly message instead of letting the raw error propagate.
  async function sendTabMessageWithInjection(tabId, payload, { inject = injectTranslatorContentScript, retryFailureMessage } = {}) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      if (!isTransientExtensionError(error)) throw error;
    }

    await inject(tabId);

    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      if (retryFailureMessage && isTransientExtensionError(error)) {
        throw new Error(retryFailureMessage);
      }
      throw error;
    }
  }

  // Show only the active provider's `.provider-field` rows and disable controls in the hidden
  // ones (popup + options). `controlSelector` lets each page scope which controls it toggles.
  function syncProviderFieldVisibility(activeProvider, providerFieldsContainer, controlSelector = "input, select") {
    let visibleCount = 0;

    document.querySelectorAll(".provider-field").forEach((field) => {
      const isVisible = field.dataset.providerField === activeProvider;
      field.hidden = !isVisible;
      field.setAttribute("aria-hidden", String(!isVisible));
      field.querySelectorAll(controlSelector).forEach((control) => {
        control.disabled = !isVisible;
      });
      if (isVisible) visibleCount += 1;
    });

    providerFieldsContainer.hidden = visibleCount === 0;
    providerFieldsContainer.setAttribute("aria-hidden", String(visibleCount === 0));
  }

  Object.assign(globalThis, {
    clamp,
    isPlainObject,
    isSupportedPageUrl,
    isTransientExtensionError,
    parseAllowedOpenAICompatibleEndpoint,
    isAllowedOpenAICompatibleEndpoint,
    injectTranslatorContentScript,
    ensureOpenAICompatibleEndpointPermission,
    syncProviderFieldVisibility,
    sendTabMessageWithInjection
  });

  if (typeof module !== "undefined") {
    module.exports = {
      clamp,
      isPlainObject,
      isSupportedPageUrl,
      isTransientExtensionError,
      parseAllowedOpenAICompatibleEndpoint,
      isAllowedOpenAICompatibleEndpoint,
      injectTranslatorContentScript,
      ensureOpenAICompatibleEndpointPermission,
      syncProviderFieldVisibility,
      sendTabMessageWithInjection
    };
  }
})();
