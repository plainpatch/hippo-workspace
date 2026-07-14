import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { config } from "./config.js";
import { CredentialStore } from "./credential-store.js";

const OVERRIDE_KEYS = [
  "resourceRootPath",
  "codexSandboxMode",
  "anythingllmBaseUrl",
];

export class AppSettingsService {
  constructor(initial = config, { credentialStore } = {}) {
    this.initial = initial;
    this.settingsPath = path.join(initial.appHomePath, "app-settings.json");
    this.credentialStore = credentialStore || new CredentialStore({ appHomePath: initial.appHomePath });
    this.settings = this.buildSettings(this.readOverrides());
  }

  buildSettings(overrides = {}) {
    const resourceRootPath = overrides.resourceRootPath || this.initial.resourceRootPath;
    const credential = this.getAnythingLlmCredentials();
    return {
      appHomePath: this.initial.appHomePath,
      resourceRootPath,
      workspacesPath: path.join(resourceRootPath, "workspaces"),
      knowledgePath: path.join(resourceRootPath, "knowledge"),
      settingsPath: this.settingsPath,
      agentStorePath: this.initial.agentStorePath,
      defaultRuntimeId: this.initial.defaultRuntimeId,
      ragProviderId: this.initial.ragProviderId,
      runtimes: {
        codex: {
          id: "codex",
          name: "Codex",
          command: this.initial.codexCommand,
          transport: this.initial.codexTransport || "app-server",
          model: process.env.CODEX_MODEL || readCodexConfigValue("model") || this.initial.codexModel || undefined,
          sandboxMode: overrides.codexSandboxMode || this.initial.codexSandboxMode || "workspace-write",
          serviceTier: process.env.CODEX_SERVICE_TIER || readCodexConfigValue("service_tier") || this.initial.codexServiceTier || "fast",
        },
      },
      ragProviders: {
        anythingllm: {
          id: "anythingllm",
          name: "AnythingLLM",
          baseUrl: normalizeBaseUrl(overrides.anythingllmBaseUrl || this.initial.anythingllmBaseUrl),
          apiKeyConfigured: Boolean(credential.apiKey),
          credentialSource: credential.source,
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

  getAnythingLlmCredentials() {
    if (this.initial.anythingllmApiKey) {
      return { apiKey: this.initial.anythingllmApiKey, source: "environment" };
    }
    return this.credentialStore.getAnythingLlmCredential();
  }

  updateSettings(payload = {}) {
    validateSettingsPayload(payload);
    const current = this.readOverrides();
    const before = this.buildSettings(current);
    const merged = { ...current };
    for (const key of OVERRIDE_KEYS) {
      if (!(key in payload)) continue;
      const value = payload[key];
      if (value === null || String(value).trim() === "") delete merged[key];
      else merged[key] = value;
    }
    if (!this.initial.anythingllmApiKey) {
      if (payload.clearAnythingllmApiKey === true) this.credentialStore.deleteAnythingLlmApiKey();
      else if (String(payload.anythingllmApiKey || "").trim()) {
        this.credentialStore.setAnythingLlmApiKey(payload.anythingllmApiKey);
      }
    }
    const next = sanitizeOverrides(merged);
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

function readCodexConfigValue(key) {
  try {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const content = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const topLevel = content.split(/^\s*\[/m, 1)[0];
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return topLevel.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1] || "";
  } catch {
    return "";
  }
}

function sanitizeOverrides(value = {}) {
  const result = {};
  for (const key of OVERRIDE_KEYS) {
    if (value[key] !== undefined && value[key] !== null) result[key] = String(value[key]).trim();
  }
  return Object.fromEntries(Object.entries(result).filter(([, item]) => item !== ""));
}

function detectRestartRequired(before, after) {
  return {
    resourceRootPath: before.resourceRootPath !== after.resourceRootPath,
  };
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function validateSettingsPayload(payload) {
  if (payload.resourceRootPath !== undefined) {
    const rootPath = String(payload.resourceRootPath || "").trim();
    if (rootPath && !path.isAbsolute(rootPath)) {
      throw new AppSettingsError("资源根目录必须是绝对路径。");
    }
    if (rootPath) {
      try {
        fs.mkdirSync(rootPath, { recursive: true });
        fs.accessSync(rootPath, fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        throw new AppSettingsError("资源根目录不可读写。");
      }
    }
  }
  if (payload.anythingllmBaseUrl !== undefined && String(payload.anythingllmBaseUrl).trim()) {
    try {
      const url = new URL(String(payload.anythingllmBaseUrl));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      throw new AppSettingsError("AnythingLLM 服务地址必须是有效的 HTTP(S) URL。");
    }
  }
  if (payload.codexSandboxMode !== undefined &&
      !["workspace-write", "read-only", "danger-full-access"].includes(payload.codexSandboxMode)) {
    throw new AppSettingsError("Codex 默认文件权限无效。");
  }
}

export class AppSettingsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AppSettingsError";
    this.status = status;
  }
}
