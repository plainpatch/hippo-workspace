import path from "node:path";
import { config } from "./config.js";

export class AppSettingsService {
  constructor(initial = config) {
    this.settings = {
      appHomePath: initial.appHomePath,
      projectsPath: path.join(initial.resourceRootPath, "projects"),
      knowledgePath: path.join(initial.resourceRootPath, "knowledge"),
      agentStorePath: initial.agentStorePath,
      defaultRuntimeId: initial.defaultRuntimeId,
      ragProviderId: initial.ragProviderId,
      runtimes: {
        codex: {
          id: "codex",
          name: "Codex",
          command: initial.codexCommand,
          model: initial.codexModel || undefined,
        },
      },
      ragProviders: {
        anythingllm: {
          id: "anythingllm",
          name: "AnythingLLM",
          baseUrl: initial.anythingllmBaseUrl,
        },
      },
    };
  }

  getSettings() {
    return this.settings;
  }

  getRuntime(id = this.settings.defaultRuntimeId) {
    return this.settings.runtimes[id];
  }

  getRagProvider(id = this.settings.ragProviderId) {
    return this.settings.ragProviders[id];
  }
}
