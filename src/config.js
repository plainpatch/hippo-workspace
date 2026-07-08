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
  codexModel: process.env.CODEX_MODEL || "",
  agentStorePath:
    process.env.AGENT_STORE_PATH || path.join(appHomePath, "agents", "agent-store.json"),
  resourceRootPath:
    process.env.RESOURCE_ROOT_PATH || appHomePath,
};

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
