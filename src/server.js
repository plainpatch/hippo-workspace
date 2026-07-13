import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
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
const client = createAnythingLlmClient();
const appSettings = new AppSettingsService();
const settings = appSettings.getSettings();
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

await agentOrchestrator.reconcileInterruptedRuns();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/vendor/marked", express.static(path.join(nodeModulesDir, "marked", "lib")));
app.use("/vendor/dompurify", express.static(path.join(nodeModulesDir, "dompurify", "dist")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mcp", asyncHandler(handleMcpPost));
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

app.get("/api/settings", (_req, res) => {
  res.json({ settings });
});

app.patch("/api/settings", (req, res) => {
  const result = appSettings.updateSettings(req.body || {});
  Object.assign(settings, result.settings);
  runtimeRegistry.updateSettings(settings);
  agentOrchestrator.settings = settings;
  res.json(result);
});

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

app.post("/api/knowledge/text", asyncHandler(async (req, res) => {
  res.json(await resourceManager.ingestKnowledgeText(req.body));
}));

app.post("/api/knowledge/upload", upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new AnythingLlmError("Missing multipart file field.", 400);
  res.json(await resourceManager.ingestKnowledgeFile({
    fileBuffer: req.file.buffer,
    fileName: req.file.originalname,
    relativeDir: req.body.relativeDir || "",
    metadata: parseMetadata(req.body.metadata),
  }));
}));

app.get("/api/workspaces", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.listWorkspaces());
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
  res.json(await agentOrchestrator.resumeNodeRun(req.params.id, req.params.runId, req.body));
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
