import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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
      workspacesPath: path.join(resourceRootPath, "workspaces"),
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
          transport: overrides.codexTransport || this.initial.codexTransport || "app-server",
          model: overrides.codexModel || this.initial.codexModel || readCodexDefaultModel() || undefined,
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

function readCodexDefaultModel() {
  try {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const content = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const topLevel = content.split(/^\s*\[/m, 1)[0];
    return topLevel.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] || "";
  } catch {
    return "";
  }
}

function sanitizeOverrides(value = {}) {
  const result = {};
  for (const key of [
    "resourceRootPath",
    "defaultRuntimeId",
    "ragProviderId",
    "codexCommand",
    "codexTransport",
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
