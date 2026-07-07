import { config } from "./config.js";
import { AnythingLlmClient } from "./anythingllm-client.js";

export function createAnythingLlmClient() {
  return new AnythingLlmClient({
    baseUrl: config.anythingllmBaseUrl,
    apiKey: config.anythingllmApiKey,
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
