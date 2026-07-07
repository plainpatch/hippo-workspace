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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const upload = multer({ storage: multer.memoryStorage() });
const app = express();
const client = createAnythingLlmClient();
const agentOrchestrator = new AgentOrchestrator({ client });
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
    wrapper: { ok: true, port: config.wrapperPort, agentStorePath: config.agentStorePath },
    anythingllm: await client.status(),
  });
}));

app.get("/api/agent-workspaces", asyncHandler(async (_req, res) => {
  res.json(await agentOrchestrator.listAgentWorkspaces());
}));

app.post("/api/agent-workspaces", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.createAgentWorkspace(req.body));
}));

app.get("/api/agent-workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.getAgentWorkspace(req.params.id));
}));

app.patch("/api/agent-workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateAgentWorkspace(req.params.id, req.body));
}));

app.delete("/api/agent-workspaces/:id", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.deleteAgentWorkspace(req.params.id));
}));

app.post("/api/agent-workspaces/:id/rag-scope", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.updateRagScope(req.params.id, req.body));
}));

app.post("/api/agent-workspaces/:id/execute", asyncHandler(async (req, res) => {
  res.json(await agentOrchestrator.executeAgentTask(req.params.id, req.body));
}));

app.get("/api/workspaces", asyncHandler(async (_req, res) => {
  res.json(await client.listWorkspaces());
}));

app.post("/api/workspaces", asyncHandler(async (req, res) => {
  res.json(await client.createWorkspace(req.body));
}));

app.get("/api/documents", asyncHandler(async (_req, res) => {
  res.json(await client.listDocuments());
}));

app.post("/api/documents/raw", asyncHandler(async (req, res) => {
  res.json(await client.uploadRawText(req.body));
}));

app.post("/api/documents/link", asyncHandler(async (req, res) => {
  res.json(await client.uploadLink(req.body));
}));

app.post("/api/documents/upload", upload.single("file"), asyncHandler(async (req, res) => {
  if (!req.file) throw new AnythingLlmError("Missing multipart file field.", 400);
  res.json(await client.uploadFile({
    fileBuffer: req.file.buffer,
    fileName: req.file.originalname,
    addToWorkspaces: req.body.addToWorkspaces,
    metadata: parseMetadata(req.body.metadata),
  }));
}));

app.delete("/api/documents", asyncHandler(async (req, res) => {
  res.json(await client.removeDocuments(req.body.names || []));
}));

app.post("/api/workspaces/:slug/update-embeddings", asyncHandler(async (req, res) => {
  res.json(await client.updateWorkspaceEmbeddings(req.params.slug, req.body));
}));

app.post("/api/workspaces/:slug/chat", asyncHandler(async (req, res) => {
  res.json(await client.workspaceChat(req.params.slug, req.body));
}));

app.post("/api/workspaces/:slug/vector-search", asyncHandler(async (req, res) => {
  res.json(await client.vectorSearch(req.params.slug, req.body));
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
