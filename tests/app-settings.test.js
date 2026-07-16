import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppSettingsService } from "../src/app-settings.js";
import { CredentialStore } from "../src/credential-store.js";
import { RuntimeRegistry } from "../src/runtime-adapter.js";

test("app settings load credentials automatically, keep them private, and support clearing editable overrides", async (t) => {
  const appHomePath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-settings-"));
  t.after(() => fs.rm(appHomePath, { recursive: true, force: true }));
  const codexHome = path.join(appHomePath, "codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), 'model = "auto-model"\nservice_tier = "auto-tier"\n');
  const previousCodexHome = process.env.CODEX_HOME;
  const previousCodexModel = process.env.CODEX_MODEL;
  const previousServiceTier = process.env.CODEX_SERVICE_TIER;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_MODEL;
  delete process.env.CODEX_SERVICE_TIER;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousCodexModel === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previousCodexModel;
    if (previousServiceTier === undefined) delete process.env.CODEX_SERVICE_TIER;
    else process.env.CODEX_SERVICE_TIER = previousServiceTier;
  });
  const credentialStore = new MemoryCredentialStore();
  const service = new AppSettingsService(createInitialSettings(appHomePath), { credentialStore });

  let settings = service.getSettings();
  assert.equal(settings.ragProviders.anythingllm.apiKeyConfigured, false);
  assert.equal("apiKey" in settings.ragProviders.anythingllm, false);

  settings = service.updateSettings({
    anythingllmBaseUrl: "http://127.0.0.1:3001/",
    anythingllmApiKey: "developer-key",
  }).settings;
  assert.equal(settings.ragProviders.anythingllm.baseUrl, "http://127.0.0.1:3001");
  assert.equal(settings.ragProviders.anythingllm.apiKeyConfigured, true);
  assert.equal(service.getAnythingLlmCredentials().apiKey, "developer-key");
  assert.equal(settings.runtimes.codex.model, "auto-model");
  assert.equal(settings.runtimes.codex.serviceTier, "auto-tier");

  settings = service.updateSettings({ anythingllmBaseUrl: "" }).settings;
  assert.equal(settings.ragProviders.anythingllm.baseUrl, "http://localhost:3001");
  assert.throws(() => service.updateSettings({ anythingllmBaseUrl: "not-a-url" }), /HTTP\(S\) URL/);
});

test("unrelated settings updates do not close the active Codex runtime", () => {
  const settings = createInitialSettings("/tmp/hippo-runtime-settings");
  settings.runtimes = {
    codex: {
      command: "codex",
      transport: "app-server",
      model: "model",
      sandboxMode: "workspace-write",
      serviceTier: "fast",
    },
  };
  const registry = new RuntimeRegistry({ settings });
  let closeCount = 0;
  registry.codexRuntime = { close() { closeCount += 1; } };

  registry.updateSettings({ ...settings, ragProviderId: "anythingllm" });
  assert.equal(closeCount, 0);

  registry.updateSettings({
    ...settings,
    runtimes: { codex: { ...settings.runtimes.codex, sandboxMode: "read-only" } },
  });
  assert.equal(closeCount, 1);
});

test("credential fallback file is private and never exposed through app settings", async (t) => {
  const appHomePath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-credentials-"));
  t.after(() => fs.rm(appHomePath, { recursive: true, force: true }));
  const store = new CredentialStore({ appHomePath, platform: "linux", account: "test" });
  store.setAnythingLlmApiKey("local-developer-key");

  assert.deepEqual(store.getAnythingLlmCredential(), {
    apiKey: "local-developer-key",
    source: "local-file",
  });
  const credentialPath = path.join(appHomePath, "credentials.json");
  assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);

  store.deleteAnythingLlmApiKey();
  await assert.rejects(fs.access(credentialPath));
});

class MemoryCredentialStore {
  apiKey = "";

  getAnythingLlmCredential() {
    return { apiKey: this.apiKey, source: this.apiKey ? "memory" : "none" };
  }

  setAnythingLlmApiKey(value) {
    this.apiKey = String(value);
  }

  deleteAnythingLlmApiKey() {
    this.apiKey = "";
  }
}

function createInitialSettings(appHomePath) {
  return {
    appHomePath,
    resourceRootPath: appHomePath,
    metadataDbPath: path.join(appHomePath, "agents.json"),
    defaultRuntimeId: "codex",
    ragProviderId: "anythingllm",
    codexCommand: "codex",
    codexTransport: "app-server",
    codexModel: "base-model",
    codexSandboxMode: "workspace-write",
    codexServiceTier: "fast",
    anythingllmBaseUrl: "http://localhost:3001",
    anythingllmApiKey: "",
  };
}
