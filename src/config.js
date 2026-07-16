import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";

dotenv.config({ quiet: true });

const defaultAppHomePath = path.join(os.homedir(), ".hippo");
const appHomePath = process.env.HIPPO_APP_HOME || defaultAppHomePath;

export const config = {
  wrapperPort: Number(process.env.WRAPPER_PORT || 8787),
  anythingllmBaseUrl: normalizeBaseUrl(
    process.env.ANYTHINGLLM_BASE_URL || "http://localhost:3001"
  ),
  anythingllmApiKey: process.env.ANYTHINGLLM_API_KEY || "",
  appHomePath,
  defaultRuntimeId: process.env.HIPPO_DEFAULT_RUNTIME || "codex",
  ragProviderId: process.env.HIPPO_RAG_PROVIDER || "anythingllm",
  codexCommand: process.env.CODEX_COMMAND || "codex",
  codexTransport: process.env.CODEX_TRANSPORT || "app-server",
  codexModel: process.env.CODEX_MODEL || "",
  codexSandboxMode: process.env.CODEX_SANDBOX_MODE || "workspace-write",
  codexServiceTier: process.env.CODEX_SERVICE_TIER || "fast",
  metadataDbPath: process.env.HIPPO_DATABASE_PATH || path.join(appHomePath, "metadata", "hippo.sqlite3"),
  resourceRootPath:
    process.env.RESOURCE_ROOT_PATH || appHomePath,
};

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
