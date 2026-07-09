import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";

export class AppSettingsService {
  constructor(initial = config) {
    this.initial = initial;
    this.settingsPath = path.join(initial.appHomePath, "app-settings.json");
    this.settings = this.buildSettings(this.readOverrides());
  }

  buildSettings(overrides = {}) {
    const resourceRootPath = overrides.resourceRootPath || this.initial.resourceRootPath;
    const defaultRuntimeId = overrides.defaultRuntimeId || this.initial.defaultRuntimeId;
    const ragProviderId = overrides.ragProviderId || this.initial.ragProviderId;
    return {
      appHomePath: this.initial.appHomePath,
      resourceRootPath,
      projectsPath: path.join(resourceRootPath, "projects"),
      knowledgePath: path.join(resourceRootPath, "knowledge"),
      settingsPath: this.settingsPath,
      agentStorePath: this.initial.agentStorePath,
      defaultRuntimeId,
      ragProviderId,
      runtimes: {
        codex: {
          id: "codex",
          name: "Codex",
          command: overrides.codexCommand || this.initial.codexCommand,
          model: overrides.codexModel || this.initial.codexModel || undefined,
          sandboxMode: overrides.codexSandboxMode || this.initial.codexSandboxMode || "workspace-write",
          serviceTier: overrides.codexServiceTier || this.initial.codexServiceTier || "fast",
        },
      },
      ragProviders: {
        anythingllm: {
          id: "anythingllm",
          name: "AnythingLLM",
          baseUrl: overrides.anythingllmBaseUrl || this.initial.anythingllmBaseUrl,
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

  updateSettings(payload = {}) {
    const current = this.readOverrides();
    const before = this.buildSettings(current);
    const next = sanitizeOverrides({ ...current, ...payload });
    const after = this.buildSettings(next);
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = after;
    return {
      settings: this.settings,
      overrides: next,
      requiresRestart: detectRestartRequired(before, after),
    };
  }

  readOverrides() {
    try {
      return sanitizeOverrides(JSON.parse(fs.readFileSync(this.settingsPath, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }
}

function sanitizeOverrides(value = {}) {
  const result = {};
  for (const key of [
    "resourceRootPath",
    "defaultRuntimeId",
    "ragProviderId",
    "codexCommand",
    "codexModel",
    "codexSandboxMode",
    "codexServiceTier",
    "anythingllmBaseUrl",
  ]) {
    if (value[key] !== undefined && value[key] !== null) result[key] = String(value[key]).trim();
  }
  return Object.fromEntries(Object.entries(result).filter(([, item]) => item !== ""));
}

function detectRestartRequired(before, after) {
  return {
    resourceRootPath: before.resourceRootPath !== after.resourceRootPath,
    ragProvider:
      before.ragProviderId !== after.ragProviderId ||
      before.ragProviders?.anythingllm?.baseUrl !== after.ragProviders?.anythingllm?.baseUrl,
    agentStorePath: false,
  };
}
