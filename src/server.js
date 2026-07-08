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
const resourceManager = new ResourceManager({ client: ragProvider });
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
    anythingllm: await ragProvider.status(),
  });
}));

app.get("/api/settings", (_req, res) => {
  res.json({ settings });
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

app.get("/api/agents", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.listAgents());
}));

app.post("/api/agents", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createAgent(req.body));
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

app.get("/api/projects/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getProject(req.params.id));
}));

app.patch("/api/projects/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateProject(req.params.id, req.body));
}));

app.delete("/api/projects/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteProject(req.params.id));
}));

app.get("/api/projects/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.listConversations(req.params.id));
}));

app.post("/api/projects/:id/conversations", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createConversation(req.params.id, req.body));
}));

app.get("/api/projects/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getConversation(req.params.id, req.params.conversationId));
}));

app.patch("/api/projects/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateConversation(req.params.id, req.params.conversationId, req.body));
}));

app.delete("/api/projects/:id/conversations/:conversationId", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteConversation(req.params.id, req.params.conversationId));
}));

app.post("/api/projects/:id/execute", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.executeAgentTask(req.params.id, req.body));
}));

app.post("/api/projects/:id/execute/stream", asyncHandler(async (req, res) => {
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
    send({
      type: "error",
      error: error.message || "Unexpected stream error.",
      details: error.details || error.issues,
    });
  } finally {
    res.end();
  }
}));

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
