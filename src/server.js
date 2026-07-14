import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AnythingLlmError, parseMetadata } from "./anythingllm-client.js";
import { config } from "./config.js";
import { createMcpServer, createRagMcpServer } from "./mcp.js";
import { createAnythingLlmClient } from "./shared.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { ResourceManager } from "./resource-manager.js";
import { AppSettingsService } from "./app-settings.js";
import { createRagProvider } from "./rag-provider.js";
import { RuntimeRegistry } from "./runtime-adapter.js";
import { ExecutionManager } from "./execution-manager.js";
import { decodeMultipartFileName } from "./filename-utils.js";
import { HippoSkillInstaller } from "./skill-installer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const nodeModulesDir = path.join(__dirname, "..", "node_modules");
const inlineTextExtensions = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".html",
  ".ini", ".java", ".js", ".json", ".jsx", ".log", ".md", ".mjs", ".py", ".rb",
  ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const upload = multer({ storage: multer.memoryStorage() });
const app = express();
const appSettings = new AppSettingsService();
const settings = appSettings.getSettings();
const client = createAnythingLlmClient({
  baseUrl: settings.ragProviders.anythingllm.baseUrl,
  apiKey: appSettings.getAnythingLlmCredentials().apiKey,
});
const ragProvider = createRagProvider({ id: settings.ragProviderId, client });
const resourceManager = new ResourceManager({ rootPath: settings.resourceRootPath, client: ragProvider });
const runtimeRegistry = new RuntimeRegistry({ settings });
const agentOrchestrator = new AgentOrchestrator({
  client,
  ragProvider,
  resourceManager,
  runtimeRegistry,
  settings,
});
const mcpSessions = new Map();
const executionManager = new ExecutionManager();
const skillInstaller = new HippoSkillInstaller({
  sourceRoot: path.join(__dirname, "..", ".agents", "skills"),
});

await agentOrchestrator.reconcileInterruptedRuns();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/vendor/marked", express.static(path.join(nodeModulesDir, "marked", "lib")));
app.use("/vendor/dompurify", express.static(path.join(nodeModulesDir, "dompurify", "dist")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mcp", asyncHandler((req, res) => handleMcpPost(req, res, () => createMcpServer({
  agentOrchestrator,
  settings,
}))));
app.get("/mcp", asyncHandler(handleMcpSessionRequest));
app.delete("/mcp", asyncHandler(handleMcpSessionRequest));
app.post("/mcp/rag", asyncHandler((req, res) => handleMcpPost(req, res, () => createRagMcpServer({
  workspaceId: String(req.query.workspaceId || ""),
  topN: Number(req.query.topN) || 4,
}))));
app.get("/mcp/rag", asyncHandler(handleMcpSessionRequest));
app.delete("/mcp/rag", asyncHandler(handleMcpSessionRequest));

app.get("/api/status", asyncHandler(async (_req, res) => {
  res.json({
    wrapper: {
      ok: true,
      port: config.wrapperPort,
      agentStorePath: config.agentStorePath,
      settings,
      resources: await resourceManager.getStatus(),
    },
    anythingllm: await safeRagStatus(),
  });
}));

app.get("/api/skills/hippo-agent-builder", asyncHandler(async (_req, res) => {
  res.json(await skillInstaller.getAgentBuilderStatus());
}));

app.post("/api/skills/hippo-agent-builder/install", asyncHandler(async (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "Skill installation is only available from this device." });
    return;
  }
  res.json(await skillInstaller.installAgentBuilder());
}));

app.get("/api/settings", (_req, res) => {
  res.json({ settings });
});

app.patch("/api/settings", (req, res) => {
  const result = appSettings.updateSettings(req.body || {});
  Object.assign(settings, result.settings);
  client.configure({
    baseUrl: settings.ragProviders.anythingllm.baseUrl,
    apiKey: appSettings.getAnythingLlmCredentials().apiKey,
  });
  runtimeRegistry.updateSettings(settings);
  agentOrchestrator.settings = settings;
  res.json(result);
});

app.get("/api/settings/diagnostics", asyncHandler(async (_req, res) => {
  const codex = settings.runtimes.codex;
  res.json({
    codex: await inspectCommand(codex.command, ["--version"]),
    anythingllm: await safeRagStatus(),
  });
}));

app.post("/api/settings/test-rag", asyncHandler(async (req, res) => {
  const storedCredential = appSettings.getAnythingLlmCredentials();
  const candidate = createAnythingLlmClient({
    baseUrl: String(req.body?.baseUrl || settings.ragProviders.anythingllm.baseUrl),
    apiKey: String(req.body?.apiKey || storedCredential.apiKey),
  });
  try {
    res.json({ ...(await candidate.status()), credentialSource: req.body?.apiKey ? "input" : storedCredential.source });
  } catch (error) {
    res.json({
      ok: false,
      error: error.message || "AnythingLLM connection failed.",
      status: error.status || 500,
      baseUrl: candidate.baseUrl,
      credentialSource: req.body?.apiKey ? "input" : storedCredential.source,
    });
  }
}));

app.get("/api/resources", asyncHandler(async (_req, res) => {
  res.json(await resourceManager.getStatus());
}));

app.get("/api/knowledge", asyncHandler(async (_req, res) => {
  res.json(await resourceManager.listKnowledgeTree());
}));

app.patch("/api/knowledge/nodes", asyncHandler(async (req, res) => {
  res.json(await resourceManager.updateKnowledgeNode(req.body));
}));

app.post("/api/knowledge/domains", asyncHandler(async (req, res) => {
  res.json(await resourceManager.createKnowledgeDomain(req.body));
}));

app.post("/api/knowledge/topics", asyncHandler(async (req, res) => {
  res.json(await resourceManager.createKnowledgeTopic(req.body));
}));

app.post("/api/knowledge/topics/sync", asyncHandler(async (req, res) => {
  res.json(await resourceManager.syncTopicWorkspace(req.body.topicPath, { force: Boolean(req.body.force) }));
}));

app.post("/api/knowledge/reveal", asyncHandler(async (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "File manager actions are only available from this device." });
    return;
  }
  const target = await resourceManager.resolveKnowledgePath(req.body?.path);
  await revealInFileManager(target);
  res.json({ ok: true, path: target.relativePath });
}));

app.post("/api/knowledge/text", asyncHandler(async (req, res) => {
  res.json(await resourceManager.ingestKnowledgeText(req.body));
}));

app.post("/api/knowledge/upload", upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new AnythingLlmError("Missing multipart file field.", 400);
  res.json(await resourceManager.ingestKnowledgeFile({
    fileBuffer: req.file.buffer,
    fileName: decodeMultipartFileName(req.file.originalname),
    relativeDir: req.body.relativeDir || "",
    metadata: parseMetadata(req.body.metadata),
  }));
}));

app.get("/api/workspaces", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.listWorkspaces());
}));

app.post("/api/workspaces/default", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.ensureDefaultWorkspace());
}));

app.get("/api/agents", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.listAgents());
}));

app.post("/api/agents", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createAgent(req.body));
}));

app.post("/api/agents/validate", asyncHandler(async (req, res) => {
  res.json(agentOrchestrator.validateAgent(req.body));
}));

app.get("/api/agents/schema", (_req, res) => {
  res.json(agentOrchestrator.getAgentSchema());
});

app.get("/api/agents/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getAgent(req.params.id));
}));

app.patch("/api/agents/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateAgent(req.params.id, req.body));
}));

app.delete("/api/agents/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteAgent(req.params.id));
}));

app.post("/api/workspaces", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createWorkspace(req.body));
}));

app.get("/api/workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getWorkspace(req.params.id));
}));

app.get("/workspace-files/:id", asyncHandler(async (req, res) => {
  const { workspace } = await agentOrchestrator.getWorkspace(req.params.id);
  const workspaceRoot = path.resolve(workspace.localWorkspacePath || "");
  const requestedPath = String(req.query.path || "").trim();
  if (!workspace.localWorkspacePath || !requestedPath) {
    res.status(400).json({ error: "Workspace file path is required." });
    return;
  }

  const filePath = path.resolve(workspaceRoot, requestedPath);
  const relativePath = path.relative(workspaceRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    res.status(403).json({ error: "Workspace file path is outside the workspace." });
    return;
  }

  let file;
  let realWorkspaceRoot;
  let realFilePath;
  try {
    [realWorkspaceRoot, realFilePath] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(filePath),
    ]);
    const realRelativePath = path.relative(realWorkspaceRoot, realFilePath);
    if (realRelativePath.startsWith("..") || path.isAbsolute(realRelativePath)) {
      res.status(403).json({ error: "Workspace file path is outside the workspace." });
      return;
    }
    file = await fs.stat(realFilePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    res.status(404).json({ error: "Workspace file was not found." });
    return;
  }
  if (!file.isFile()) {
    res.status(400).json({ error: "Workspace path does not reference a file." });
    return;
  }
  if (inlineTextExtensions.has(path.extname(realFilePath).toLowerCase())) {
    const contents = await fs.readFile(realFilePath, "utf8");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.type("html").send(renderWorkspaceFile(contents, path.basename(realFilePath)));
    return;
  }
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`);
  res.sendFile(realFilePath);
}));

app.get("/knowledge-files", asyncHandler(async (req, res) => {
  const target = await resourceManager.resolveKnowledgePath(req.query.path);
  if (target.type !== "file") {
    res.status(400).json({ error: "Knowledge path does not reference a file." });
    return;
  }
  if (inlineTextExtensions.has(path.extname(target.absolutePath).toLowerCase())) {
    const contents = await fs.readFile(target.absolutePath, "utf8");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    res.type("html").send(renderWorkspaceFile(contents, path.basename(target.absolutePath)));
    return;
  }
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(target.absolutePath))}`);
  res.sendFile(target.absolutePath);
}));

app.get("/api/workspaces/:id/knowledge-index", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getWorkspaceKnowledgeIndex(req.params.id));
}));

app.post("/api/workspaces/:id/rag-plan", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getWorkspaceKnowledgePlan(req.params.id, req.body));
}));

app.post("/api/workspaces/:id/rag-search", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.searchWorkspaceKnowledge(req.params.id, req.body));
}));

app.patch("/api/workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateWorkspace(req.params.id, req.body));
}));

app.delete("/api/workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteWorkspace(req.params.id));
}));

app.get("/api/workspaces/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listConversations(req.params.id));
}));

app.post("/api/workspaces/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createConversation(req.params.id, req.body));
}));

app.get("/api/workspaces/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getConversation(req.params.id, req.params.conversationId));
}));

app.patch("/api/workspaces/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateConversation(req.params.id, req.params.conversationId, req.body));
}));

app.delete("/api/workspaces/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteConversation(req.params.id, req.params.conversationId));
}));

app.post("/api/workspaces/:id/runs", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createGraphRun(req.params.id, req.body));
}));

app.get("/api/workspaces/:id/runs", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listAgentRuns(req.params.id, {
    rootSessionId: req.query.rootSessionId || "",
  }));
}));

app.get("/api/workspaces/:id/runs/:runId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getAgentRun(req.params.id, req.params.runId));
}));

app.get("/api/workspaces/:id/runs/:runId/nodes/:nodeRunId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getNodeRun(req.params.id, req.params.runId, req.params.nodeRunId));
}));

app.get("/api/workspaces/:id/runs/:runId/trace", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listAgentRunTrace(req.params.id, req.params.runId, {
    nodeRunId: req.query.nodeRunId || "",
    nodeId: req.query.nodeId || "",
  }));
}));

app.post("/api/workspaces/:id/runs/:runId/trace", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.appendAgentRunTraceEvent(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/advance", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.advanceGraphRun(req.params.id, req.params.runId));
}));

app.post("/api/workspaces/:id/runs/:runId/dispatch", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.dispatchGraphNode(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/request-user", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.requestGraphRunUser(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/user-input", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.resumeGraphRunWithUserInput(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/complete", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.completeGraphRun(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/fail", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.failGraphRun(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/retry", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.retryNodeRun(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/resume", asyncHandler(async (req, res) => {
  const approved = await agentOrchestrator.approveNodeRun(req.params.id, req.params.runId, req.body);
  const key = executionKey(req.params.id, req.params.runId);
  executionManager.ensure(key, async (publish) => {
    try {
      const result = await agentOrchestrator.advanceGraphRun(req.params.id, req.params.runId, publish);
      publish({
        type: "done",
        agentRun: result.run,
        result: {
          runtimeId: result.run.request?.runtimeId || result.run.agentSnapshot?.runtimeId || config.defaultRuntimeId,
          runId: result.run.id,
          text: result.run.status === "waiting_user"
            ? result.run.output?.question || "RootAgent 正在等待用户输入。"
            : "",
          output: result.run.output,
        },
      });
    } catch (error) {
      const current = (await agentOrchestrator.getAgentRun(req.params.id, req.params.runId)).run;
      if (!isTerminalRunStatus(current.status)) {
        await agentOrchestrator.failGraphRun(req.params.id, req.params.runId, { reason: error.message }).catch(() => {});
      }
      throw error;
    }
  }, { restartCompleted: true });
  res.status(202).json(approved);
}));

app.post("/api/workspaces/:id/execute", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.executeAgentTask(req.params.id, req.body));
}));

app.post("/api/workspaces/:id/execute/stream", asyncHandler(async (req, res) => {
  await streamWorkspaceExecution(req, res);
}));

app.get("/api/workspaces/:id/runs/:runId/events", asyncHandler(async (req, res) => {
  await streamRunEvents(req, res);
}));

app.post("/api/workspaces/:id/runs/:runId/cancel", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.cancelAgentRun(req.params.id, req.params.runId));
}));

app.post("/api/runs/:runId/cancel", asyncHandler(async (req, res) => {
  res.json(agentOrchestrator.cancelRuntimeRun(req.params.runId));
}));

app.post("/api/runtime-runs/:runId/requests/:requestId/resolve", asyncHandler(async (req, res) => {
  res.json(agentOrchestrator.resolveRuntimeRequest(req.params.runId, req.params.requestId, req.body?.result || {}));
}));

app.post("/api/workspaces/:id/runs/:runId/steer", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.steerAgentRun(req.params.id, req.params.runId, req.body?.input || ""));
}));

async function streamWorkspaceExecution(req, res) {
  const payload = { ...(req.body || {}), runId: req.body?.runId || randomUUID() };
  const key = executionKey(req.params.id, payload.runId);
  executionManager.ensure(key, (publish) => agentOrchestrator.streamAgentTask(req.params.id, payload, publish));
  await subscribeExecutionResponse(req, res, key, Number(req.query.after) || 0);
}

async function streamRunEvents(req, res) {
  const key = executionKey(req.params.id, req.params.runId);
  if (!executionManager.get(key)) {
    const { run } = await agentOrchestrator.getAgentRun(req.params.id, req.params.runId);
    openSse(res);
    writeSse(res, { type: "run_snapshot", run, terminal: isTerminalRunStatus(run.status), sequence: 0 });
    res.end();
    return;
  }
  await subscribeExecutionResponse(req, res, key, Number(req.query.after) || 0);
}

function subscribeExecutionResponse(req, res, key, after) {
  openSse(res);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe;
    const close = () => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      if (!res.writableEnded) res.end();
      resolve();
    };
    const listener = (event) => {
      if (res.writableEnded || res.destroyed) return close();
      writeSse(res, event);
      if (["done", "error", "cancelled"].includes(event.type)) close();
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": heartbeat\n\n");
    }, 15000);
    heartbeat.unref?.();
    res.on("close", close);
    unsubscribe = executionManager.subscribe(key, listener, { after });
    const record = executionManager.get(key);
    if (!record || (record.status !== "running" && !settled)) close();
  });
}

function openSse(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function writeSse(res, event) {
  const eventName = String(event?.type || "message").replace(/[^\w-]/g, "-");
  res.write(`event: ${eventName}\n`);
  res.write(`id: ${event?.sequence || 0}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function executionKey(workspaceId, runId) {
  return `${workspaceId}:${runId}`;
}

function isTerminalRunStatus(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

app.use(express.static(publicDir));
app.all("/api/{*splat}", (_req, res) => {
  res.status(404).json({ error: "API endpoint was not found." });
});
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, _req, res, _next) => {
  const status = error.status || (error.name === "ZodError" ? 400 : 500);
  res.status(status).json({
    error: error.message || "Unexpected wrapper error.",
    details: error.details || error.issues,
  });
});

app.listen(config.wrapperPort, () => {
  console.log(`Hippo listening on http://localhost:${config.wrapperPort}`);
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function revealInFileManager(target) {
  if (process.platform === "darwin") {
    await execFilePromise("open", target.type === "directory" ? [target.absolutePath] : ["-R", target.absolutePath]);
    return;
  }
  if (process.platform === "win32") {
    const args = target.type === "directory" ? [target.absolutePath] : [`/select,${target.absolutePath}`];
    await execFilePromise("explorer.exe", args);
    return;
  }
  const directory = target.type === "directory" ? target.absolutePath : path.dirname(target.absolutePath);
  await execFilePromise("xdg-open", [directory]);
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => error ? reject(error) : resolve());
  });
}

function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase();
  return value === "::1" || value === "127.0.0.1" || value.startsWith("::ffff:127.");
}

function inspectCommand(command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ command, ...result });
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "检测超时" });
    }, 5000);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => finish({
      ok: code === 0,
      version: (stdout || stderr).trim().split("\n")[0] || "",
      error: code === 0 ? "" : (stderr || stdout).trim() || `退出码 ${code}`,
    }));
  });
}

function renderWorkspaceFile(contents, fileName) {
  const escape = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(fileName)}</title>
    <style>
      :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      body { margin: 0; color: #e7e7e7; background: #111; }
      header { position: sticky; top: 0; padding: 12px 20px; border-bottom: 1px solid #333; background: #181818; font: 600 14px system-ui, sans-serif; }
      pre { box-sizing: border-box; min-width: 100%; margin: 0; padding: 20px; overflow: auto; white-space: pre; line-height: 1.6; tab-size: 2; }
    </style>
  </head>
  <body><header>${escape(fileName)}</header><pre>${escape(contents)}</pre></body>
</html>`;
}

async function safeRagStatus() {
  try {
    return await ragProvider.status();
  } catch (error) {
    return {
      ok: false,
      error: error.message || "RAG provider status check failed.",
      auth: { authenticated: false },
      baseUrl: settings.ragProviders?.anythingllm?.baseUrl || config.anythingllmBaseUrl,
    };
  }
}

async function handleMcpPost(req, res, serverFactory = createMcpServer) {
  const sessionId = getMcpSessionId(req);
  const existing = sessionId ? mcpSessions.get(sessionId) : undefined;
  if (existing) {
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId || !isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid MCP session ID provided." },
      id: null,
    });
    return;
  }

  const mcpServer = serverFactory();
  let transport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      mcpSessions.set(newSessionId, { transport, server: mcpServer });
    },
  });
  transport.onclose = () => {
    const closedSessionId = transport.sessionId;
    if (closedSessionId) mcpSessions.delete(closedSessionId);
  };

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

async function handleMcpSessionRequest(req, res) {
  const sessionId = getMcpSessionId(req);
  const existing = sessionId ? mcpSessions.get(sessionId) : undefined;
  if (!existing) {
    res.status(400).send("Invalid or missing MCP session ID.");
    return;
  }
  await existing.transport.handleRequest(req, res);
}

function getMcpSessionId(req) {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}
