import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ quiet: true });

export const config = {
  wrapperPort: Number(process.env.WRAPPER_PORT || 8787),
  anythingllmBaseUrl: normalizeBaseUrl(
    process.env.ANYTHINGLLM_BASE_URL || "http://localhost:3001"
  ),
  anythingllmApiKey: process.env.ANYTHINGLLM_API_KEY || "",
  agentStorePath:
    process.env.AGENT_STORE_PATH || path.join(process.cwd(), "data", "agent-workspaces.json"),
  resourceRootPath:
    process.env.RESOURCE_ROOT_PATH || path.join(process.cwd(), "resources"),
};

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
