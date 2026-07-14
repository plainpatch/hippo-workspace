import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const KEYCHAIN_SERVICE = "com.hippo.agent.anythingllm";
const ANYTHINGLLM_KEY = "anythingllm-api-key";

export class CredentialStore {
  constructor({ appHomePath, platform = process.platform, account = os.userInfo().username } = {}) {
    this.appHomePath = appHomePath;
    this.platform = platform;
    this.account = account;
    this.fallbackPath = path.join(appHomePath, "credentials.json");
  }

  getAnythingLlmApiKey() {
    return this.getAnythingLlmCredential().apiKey;
  }

  getAnythingLlmCredential() {
    if (this.platform === "darwin") {
      try {
        const apiKey = execFileSync("security", [
          "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w",
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (apiKey) return { apiKey, source: "keychain" };
      } catch {
        // Fall back to the app-local credential file when Keychain is unavailable.
      }
    }
    const apiKey = this.readFallback()[ANYTHINGLLM_KEY] || "";
    return { apiKey, source: apiKey ? "local-file" : "none" };
  }

  setAnythingLlmApiKey(value) {
    const apiKey = String(value || "").trim();
    if (!apiKey) return this.deleteAnythingLlmApiKey();
    if (this.platform === "darwin") {
      try {
        execFileSync("security", [
          "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", this.account, "-w", apiKey,
        ], { stdio: "ignore" });
        this.deleteFallbackKey();
        return { source: "keychain" };
      } catch {
        // Fall back to a user-only local file when Keychain is unavailable.
      }
    }
    this.writeFallback({ ...this.readFallback(), [ANYTHINGLLM_KEY]: apiKey });
    return { source: "local-file" };
  }

  deleteAnythingLlmApiKey() {
    if (this.platform === "darwin") {
      try {
        execFileSync("security", [
          "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", this.account,
        ], { stdio: "ignore" });
      } catch {
        // Missing credentials are already in the desired state.
      }
    }
    this.deleteFallbackKey();
    return { source: "none" };
  }

  readFallback() {
    try {
      return JSON.parse(fs.readFileSync(this.fallbackPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  writeFallback(value) {
    fs.mkdirSync(path.dirname(this.fallbackPath), { recursive: true });
    fs.writeFileSync(this.fallbackPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(this.fallbackPath, 0o600);
  }

  deleteFallbackKey() {
    const current = this.readFallback();
    if (!(ANYTHINGLLM_KEY in current)) return;
    delete current[ANYTHINGLLM_KEY];
    if (Object.keys(current).length) this.writeFallback(current);
    else fs.rmSync(this.fallbackPath, { force: true });
  }
}
