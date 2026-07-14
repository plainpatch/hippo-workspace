import { config } from "./config.js";
import { AnythingLlmClient } from "./anythingllm-client.js";

export function createAnythingLlmClient(options = {}) {
  return new AnythingLlmClient({
    baseUrl: options.baseUrl || config.anythingllmBaseUrl,
    apiKey: options.apiKey || config.anythingllmApiKey,
  });
}

export function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
