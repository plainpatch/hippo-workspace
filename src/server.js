import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AnythingLlmError, parseMetadata } from "./anythingllm-client.js";
import { config } from "./config.js";
import { createMcpServer } from "./mcp.js";
import { createAnythingLlmClient } from "./shared.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { ResourceManager } from "./resource-manager.js";
import { AppSettingsService } from "./app-settings.js";
import { createRagProvider } from "./rag-provider.js";
import { RuntimeRegistry } from "./runtime-adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
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

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mcp", asyncHandler(handleMcpPost));
app.get("/mcp", asyncHandler(handleMcpSessionRequest));
app.delete("/mcp", asyncHandler(handleMcpSessionRequest));

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

app.post("/api/knowledge/folders", asyncHandler(async (req, res) => {
  res.json(await resourceManager.createKnowledgeFolder(req.body.path || "", req.body.metadata || req.body));
}));

app.patch("/api/knowledge/folders", asyncHandler(async (req, res) => {
  res.json(await resourceManager.updateKnowledgeDrawer(req.body));
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

app.get("/api/projects", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.listProjects());
}));

app.get("/api/workspaces", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.listProjects());
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

app.post("/api/projects", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createProject(req.body));
}));

app.post("/api/workspaces", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createProject(req.body));
}));

app.get("/api/projects/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getProject(req.params.id));
}));

app.get("/api/workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getProject(req.params.id));
}));

app.get("/api/projects/:id/knowledge-index", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getProjectKnowledgeIndex(req.params.id));
}));

app.get("/api/workspaces/:id/knowledge-index", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getProjectKnowledgeIndex(req.params.id));
}));

app.post("/api/projects/:id/rag-plan", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getProjectKnowledgePlan(req.params.id, req.body));
}));

app.post("/api/workspaces/:id/rag-plan", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getProjectKnowledgePlan(req.params.id, req.body));
}));

app.post("/api/projects/:id/rag-search", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.searchProjectKnowledge(req.params.id, req.body));
}));

app.post("/api/workspaces/:id/rag-search", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.searchProjectKnowledge(req.params.id, req.body));
}));

app.patch("/api/projects/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateProject(req.params.id, req.body));
}));

app.patch("/api/workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateProject(req.params.id, req.body));
}));

app.delete("/api/projects/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteProject(req.params.id));
}));

app.delete("/api/workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteProject(req.params.id));
}));

app.get("/api/projects/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listConversations(req.params.id));
}));

app.get("/api/workspaces/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listConversations(req.params.id));
}));

app.post("/api/projects/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createConversation(req.params.id, req.body));
}));

app.post("/api/workspaces/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createConversation(req.params.id, req.body));
}));

app.get("/api/projects/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getConversation(req.params.id, req.params.conversationId));
}));

app.get("/api/workspaces/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getConversation(req.params.id, req.params.conversationId));
}));

app.patch("/api/projects/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateConversation(req.params.id, req.params.conversationId, req.body));
}));

app.patch("/api/workspaces/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateConversation(req.params.id, req.params.conversationId, req.body));
}));

app.delete("/api/projects/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteConversation(req.params.id, req.params.conversationId));
}));

app.delete("/api/workspaces/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteConversation(req.params.id, req.params.conversationId));
}));

app.post("/api/projects/:id/runs", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createGraphRun(req.params.id, req.body));
}));

app.post("/api/workspaces/:id/runs", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createGraphRun(req.params.id, req.body));
}));

app.get("/api/projects/:id/runs", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listAgentRuns(req.params.id, {
    rootSessionId: req.query.rootSessionId || "",
  }));
}));

app.get("/api/workspaces/:id/runs", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listAgentRuns(req.params.id, {
    rootSessionId: req.query.rootSessionId || "",
  }));
}));

app.get("/api/projects/:id/runs/:runId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getAgentRun(req.params.id, req.params.runId));
}));

app.get("/api/workspaces/:id/runs/:runId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getAgentRun(req.params.id, req.params.runId));
}));

app.get("/api/projects/:id/runs/:runId/nodes/:nodeRunId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getNodeRun(req.params.id, req.params.runId, req.params.nodeRunId));
}));

app.get("/api/workspaces/:id/runs/:runId/nodes/:nodeRunId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getNodeRun(req.params.id, req.params.runId, req.params.nodeRunId));
}));

app.get("/api/projects/:id/runs/:runId/trace", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listAgentRunTrace(req.params.id, req.params.runId, {
    nodeRunId: req.query.nodeRunId || "",
    nodeId: req.query.nodeId || "",
  }));
}));

app.get("/api/workspaces/:id/runs/:runId/trace", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listAgentRunTrace(req.params.id, req.params.runId, {
    nodeRunId: req.query.nodeRunId || "",
    nodeId: req.query.nodeId || "",
  }));
}));

app.post("/api/projects/:id/runs/:runId/trace", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.appendAgentRunTraceEvent(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/trace", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.appendAgentRunTraceEvent(req.params.id, req.params.runId, req.body));
}));

app.post("/api/projects/:id/runs/:runId/advance", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.advanceGraphRun(req.params.id, req.params.runId));
}));

app.post("/api/workspaces/:id/runs/:runId/advance", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.advanceGraphRun(req.params.id, req.params.runId));
}));

app.post("/api/projects/:id/runs/:runId/retry", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.retryNodeRun(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/retry", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.retryNodeRun(req.params.id, req.params.runId, req.body));
}));

app.post("/api/projects/:id/runs/:runId/resume", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.resumeNodeRun(req.params.id, req.params.runId, req.body));
}));

app.post("/api/workspaces/:id/runs/:runId/resume", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.resumeNodeRun(req.params.id, req.params.runId, req.body));
}));

app.post("/api/projects/:id/execute", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.executeAgentTask(req.params.id, req.body));
}));

app.post("/api/workspaces/:id/execute", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.executeAgentTask(req.params.id, req.body));
}));

app.post("/api/projects/:id/execute/stream", asyncHandler(async (req, res) => {
  streamWorkspaceExecution(req, res);
}));

app.post("/api/workspaces/:id/execute/stream", asyncHandler(async (req, res) => {
  streamWorkspaceExecution(req, res);
}));

app.post("/api/projects/:id/runs/:runId/cancel", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.cancelAgentRun(req.params.id, req.params.runId));
}));

app.post("/api/workspaces/:id/runs/:runId/cancel", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.cancelAgentRun(req.params.id, req.params.runId));
}));

app.post("/api/runs/:runId/cancel", asyncHandler(async (req, res) => {
  res.json(agentOrchestrator.cancelRuntimeRun(req.params.runId));
}));

async function streamWorkspaceExecution(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await agentOrchestrator.streamAgentTask(req.params.id, req.body, send);
  } catch (error) {
    if (error.status === 499 || error.details?.cancelled) {
      send({
        type: "cancelled",
        runId: error.details?.runId || req.body?.runId || "",
        error: error.message || "Runtime run was cancelled.",
        details: error.details,
      });
      return;
    }
    send({
      type: "error",
      error: error.message || "Unexpected stream error.",
      details: error.details || error.issues,
    });
  } finally {
    res.end();
  }
}

app.use(express.static(publicDir));
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
  console.log(`AnythingLLM wrapper console listening on http://localhost:${config.wrapperPort}`);
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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

async function handleMcpPost(req, res) {
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

  const mcpServer = createMcpServer();
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
    mcpServer.close();
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
