import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createAnythingLlmClient, jsonContent } from "./shared.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { ResourceManager } from "./resource-manager.js";
import { AppSettingsService } from "./app-settings.js";
import { createRagProvider } from "./rag-provider.js";
import { RuntimeRegistry } from "./runtime-adapter.js";

export function createMcpServer() {
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

  const server = new McpServer({
    name: "hippo-system",
    version: "0.2.0",
  });

  server.registerTool(
    "hippo_get_settings",
    {
      title: "Get Hippo settings",
      description: "Return app system paths, selected runtime, and selected RAG provider.",
    },
    async () => jsonContent({ settings })
  );

  server.registerTool(
    "hippo_list_projects",
    {
      title: "List projects",
      description: "List Hippo projects managed under the app system path.",
    },
    async () => {
      return jsonContent(await agentOrchestrator.listProjects());
    }
  );

  server.registerTool(
    "hippo_create_project",
    {
      title: "Create project",
      description:
        "Create a Hippo project with optional global agent references and first-level knowledge drawer references.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        agentIds: z.array(z.string()).default([]),
        knowledgeDrawerRefs: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      return jsonContent(await agentOrchestrator.createProject(args));
    }
  );

  server.registerTool(
    "hippo_get_project",
    {
      title: "Get project",
      description: "Get a Hippo project by id.",
      inputSchema: {
        projectId: z.string().min(1),
      },
    },
    async ({ projectId }) => {
      return jsonContent(await agentOrchestrator.getProject(projectId));
    }
  );

  server.registerTool(
    "hippo_update_project",
    {
      title: "Update project",
      description: "Update project metadata, enabled global agents, and first-level knowledge drawer references.",
      inputSchema: {
        projectId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        agentIds: z.array(z.string()).optional(),
        knowledgeDrawerRefs: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ projectId, ...payload }) => {
      return jsonContent(await agentOrchestrator.updateProject(projectId, payload));
    }
  );

  server.registerTool(
    "hippo_list_agents",
    {
      title: "List agents",
      description: "List global Hippo agent definitions.",
    },
    async () => jsonContent(await agentOrchestrator.listAgents())
  );

  server.registerTool(
    "hippo_create_agent",
    {
      title: "Create agent",
      description: "Create a global agent definition with runtime, skills, MCP access, and behavior description.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(skillInputSchema()).default([]),
        mcpServers: z.array(z.string()).default([]),
        runtimeId: z.string().default("codex"),
        ragDocumentNames: z.array(z.string()).default([]),
        defaultMode: z.enum(["query", "chat", "automatic"]).default("query"),
        topN: z.number().int().positive().default(4),
        scoreThreshold: z.number().min(0).max(1).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => jsonContent(await agentOrchestrator.createAgent(args))
  );

  server.registerTool(
    "hippo_get_agent",
    {
      title: "Get agent",
      description: "Get a global agent definition by id.",
      inputSchema: {
        agentId: z.string().min(1),
      },
    },
    async ({ agentId }) => jsonContent(await agentOrchestrator.getAgent(agentId))
  );

  server.registerTool(
    "hippo_project_knowledge",
    {
      title: "Get project knowledge scope",
      description:
        "Return the first-level knowledge drawers and indexed documents a Hippo project is authorized to access.",
      inputSchema: {
        projectId: z.string().min(1),
      },
    },
    async ({ projectId }) => {
      const { project } = await agentOrchestrator.getProject(projectId);
      return jsonContent({
        project,
        knowledge: await resourceManager.listProjectKnowledge({
          drawerRefs: project.knowledgeDrawerRefs || [],
        }),
      });
    }
  );

  server.registerTool(
    "hippo_project_rag_search",
    {
      title: "Project-scoped RAG search",
      description:
        "Run RAG retrieval through the configured provider, constrained to the project's first-level knowledge drawer references. Secondary drawers are optional tags.",
      inputSchema: {
        projectId: z.string().min(1),
        query: z.string().min(1),
        tags: z.array(z.string()).default([]),
        topN: z.number().int().positive().default(4),
        scoreThreshold: z.number().min(0).max(1).optional(),
      },
    },
    async ({ projectId, query, tags, topN, scoreThreshold }) => {
      const { project } = await agentOrchestrator.getProject(projectId);
      const documentNames = await resourceManager.resolveKnowledgeForProject({
        drawerRefs: project.knowledgeDrawerRefs || [],
        tags,
      });
      if (documentNames.length) {
        await ragProvider.updateWorkspaceEmbeddings(project.anythingllmWorkspaceSlug, {
          adds: documentNames,
          deletes: [],
        });
      }
      return jsonContent({
        project,
        documentNames,
        result: documentNames.length
          ? await ragProvider.retrieve({
              workspaceSlug: project.anythingllmWorkspaceSlug,
              query,
              topN,
              scoreThreshold,
            })
          : { skipped: true, reason: "project-has-no-authorized-documents", results: [] },
      });
    }
  );

  server.registerTool(
    "hippo_execute_project_task",
    {
      title: "Execute project task",
      description:
        "Execute a task in a Hippo project using the selected runtime and an optional project-enabled global agent.",
      inputSchema: {
        projectId: z.string().min(1),
        agentId: z.string().optional(),
        task: z.string().min(1),
        mode: z.enum(["query", "chat", "automatic"]).optional(),
        sessionId: z.string().optional(),
        reset: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
        knowledgeTags: z.array(z.string()).default([]),
      },
    },
    async ({ projectId, ...payload }) =>
      jsonContent(await agentOrchestrator.executeAgentTask(projectId, payload))
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
