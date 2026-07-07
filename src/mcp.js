import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createAnythingLlmClient, jsonContent } from "./shared.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";

export function createMcpServer() {
  const client = createAnythingLlmClient();
  const agentOrchestrator = new AgentOrchestrator({ client });

  const server = new McpServer({
    name: "anythingllm-rag-wrapper",
    version: "0.1.0",
  });

  server.registerTool(
    "anythingllm_status",
    {
      title: "AnythingLLM status",
      description: "Check wrapper connectivity and AnythingLLM API authentication.",
    },
    async () => jsonContent(await client.status())
  );

  server.registerTool(
    "anythingllm_list_workspaces",
    {
      title: "List workspaces",
      description: "List AnythingLLM workspaces.",
    },
    async () => jsonContent(await client.listWorkspaces())
  );

  server.registerTool(
    "anythingllm_create_workspace",
    {
      title: "Create workspace",
      description: "Create a new AnythingLLM workspace.",
      inputSchema: {
        name: z.string().min(1),
        chatMode: z.enum(["chat", "query"]).optional(),
        similarityThreshold: z.number().min(0).max(1).optional(),
        topN: z.number().int().positive().optional(),
        openAiPrompt: z.string().optional(),
      },
    },
    async (args) => jsonContent(await client.createWorkspace(args))
  );

  server.registerTool(
    "anythingllm_list_documents",
    {
      title: "List documents",
      description: "List documents stored in AnythingLLM.",
    },
    async () => jsonContent(await client.listDocuments())
  );

  server.registerTool(
    "anythingllm_upload_text_document",
    {
      title: "Upload text document",
      description: "Create a document from raw text and optionally embed it into workspaces.",
      inputSchema: {
        title: z.string().min(1),
        textContent: z.string().min(1),
        workspaceSlugs: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ title, textContent, workspaceSlugs, metadata }) =>
      jsonContent(
        await client.uploadRawText({
          textContent,
          addToWorkspaces: workspaceSlugs,
          metadata: { title, ...(metadata || {}) },
        })
      )
  );

  server.registerTool(
    "anythingllm_upload_url",
    {
      title: "Upload URL",
      description: "Ask AnythingLLM to scrape a URL and optionally embed it into workspaces.",
      inputSchema: {
        url: z.string().url(),
        workspaceSlugs: z.array(z.string()).optional(),
        scraperHeaders: z.record(z.string(), z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ url, workspaceSlugs, scraperHeaders, metadata }) =>
      jsonContent(
        await client.uploadLink({
          link: url,
          addToWorkspaces: workspaceSlugs,
          scraperHeaders,
          metadata,
        })
      )
  );

  server.registerTool(
    "anythingllm_upload_file",
    {
      title: "Upload local file",
      description: "Upload a local file path to AnythingLLM and optionally embed it into workspaces.",
      inputSchema: {
        filePath: z.string().min(1),
        workspaceSlugs: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ filePath, workspaceSlugs, metadata }) =>
      jsonContent(
        await client.uploadFile({
          filePath,
          addToWorkspaces: workspaceSlugs,
          metadata,
        })
      )
  );

  server.registerTool(
    "anythingllm_update_workspace_embeddings",
    {
      title: "Update workspace embeddings",
      description: "Add or remove document names from a workspace embedding set.",
      inputSchema: {
        workspaceSlug: z.string().min(1),
        adds: z.array(z.string()).default([]),
        deletes: z.array(z.string()).default([]),
      },
    },
    async ({ workspaceSlug, adds, deletes }) =>
      jsonContent(await client.updateWorkspaceEmbeddings(workspaceSlug, { adds, deletes }))
  );

  server.registerTool(
    "anythingllm_workspace_chat",
    {
      title: "Workspace RAG chat",
      description: "Ask an AnythingLLM workspace. Use mode=query for retrieval-grounded Q&A.",
      inputSchema: {
        workspaceSlug: z.string().min(1),
        message: z.string().min(1),
        mode: z.enum(["query", "chat", "automatic"]).default("query"),
        sessionId: z.string().optional(),
        reset: z.boolean().optional(),
      },
    },
    async ({ workspaceSlug, ...payload }) =>
      jsonContent(await client.workspaceChat(workspaceSlug, payload))
  );

  server.registerTool(
    "anythingllm_vector_search",
    {
      title: "Vector search",
      description: "Run vector similarity search against an AnythingLLM workspace.",
      inputSchema: {
        workspaceSlug: z.string().min(1),
        query: z.string().min(1),
        topN: z.number().int().positive().default(4),
        scoreThreshold: z.number().min(0).max(1).optional(),
      },
    },
    async ({ workspaceSlug, ...payload }) =>
      jsonContent(await client.vectorSearch(workspaceSlug, payload))
  );

  server.registerTool(
    "anythingllm_remove_documents",
    {
      title: "Remove documents",
      description: "Permanently remove documents from AnythingLLM by document name.",
      inputSchema: {
        names: z.array(z.string()).min(1),
      },
    },
    async ({ names }) => jsonContent(await client.removeDocuments(names))
  );

  server.registerTool(
    "agent_list_workspaces",
    {
      title: "List agent workspaces",
      description: "List custom agent workspaces managed by the orchestration layer.",
    },
    async () => jsonContent(await agentOrchestrator.listAgentWorkspaces())
  );

  server.registerTool(
    "agent_create_workspace",
    {
      title: "Create agent workspace",
      description:
        "Create a custom agent workspace and bind it to an AnythingLLM workspace. If no AnythingLLM slug is provided, one will be created.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(skillInputSchema()).default([]),
        anythingllmWorkspaceSlug: z.string().optional(),
        anythingllmWorkspaceName: z.string().optional(),
        createAnythingllmWorkspace: z.boolean().default(true),
        ragDocumentNames: z.array(z.string()).default([]),
        defaultMode: z.enum(["query", "chat", "automatic"]).default("query"),
        topN: z.number().int().positive().default(4),
        scoreThreshold: z.number().min(0).max(1).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => jsonContent(await agentOrchestrator.createAgentWorkspace(args))
  );

  server.registerTool(
    "agent_get_workspace",
    {
      title: "Get agent workspace",
      description: "Get a custom agent workspace definition by id.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => jsonContent(await agentOrchestrator.getAgentWorkspace(id))
  );

  server.registerTool(
    "agent_update_rag_scope",
    {
      title: "Update agent RAG scope",
      description:
        "Add or remove document names from the bound AnythingLLM workspace and update the custom agent workspace scope record.",
      inputSchema: {
        id: z.string().min(1),
        adds: z.array(z.string()).default([]),
        deletes: z.array(z.string()).default([]),
      },
    },
    async ({ id, adds, deletes }) =>
      jsonContent(await agentOrchestrator.updateRagScope(id, { adds, deletes }))
  );

  server.registerTool(
    "agent_execute_task",
    {
      title: "Execute agent task",
      description:
        "Execute a task through a custom agent workspace. The orchestrator injects system prompt, allowed skills, and bound AnythingLLM RAG scope.",
      inputSchema: {
        id: z.string().min(1),
        task: z.string().min(1),
        mode: z.enum(["query", "chat", "automatic"]).optional(),
        sessionId: z.string().optional(),
        reset: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ id, ...payload }) =>
      jsonContent(await agentOrchestrator.executeAgentTask(id, payload))
  );

  return server;
}

function skillInputSchema() {
  return z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    instructions: z.string().optional(),
  });
}
