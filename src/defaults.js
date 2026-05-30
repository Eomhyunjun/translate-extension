(() => {
  const DEFAULT_SETTINGS = Object.freeze({
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
  });

  const SECRET_DEFAULTS = Object.freeze({
    openaiApiKey: "",
    microsoftApiKey: "",
    zhipuApiKey: "",
    gptApiKey: "",
    geminiApiKey: "",
    claudeApiKey: ""
  });

  const DEFAULT_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
  const SECRET_SETTING_KEYS = Object.freeze(Object.keys(SECRET_DEFAULTS));

  Object.assign(globalThis, {
    BIT_DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    BIT_SECRET_DEFAULTS: SECRET_DEFAULTS,
    BIT_DEFAULT_SETTING_KEYS: DEFAULT_SETTING_KEYS,
    BIT_SECRET_SETTING_KEYS: SECRET_SETTING_KEYS
  });

  if (typeof module !== "undefined") {
    module.exports = {
      DEFAULT_SETTINGS,
      SECRET_DEFAULTS,
      DEFAULT_SETTING_KEYS,
      SECRET_SETTING_KEYS
    };
  }
})();
