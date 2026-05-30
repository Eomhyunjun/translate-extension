const DEFAULT_SETTINGS = {
  provider: "google",
  targetLang: "ko",
  sourceLang: "en",
  viewMode: "inline",
  displayMode: "below",
  translateScope: "viewport",
  skipTranslated: true,
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

if (typeof module !== "undefined") {
  module.exports = { DEFAULT_SETTINGS };
}
