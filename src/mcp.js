import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createAnythingLlmClient, jsonContent } from "./shared.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import { ResourceManager } from "./resource-manager.js";
import { AppSettingsService } from "./app-settings.js";
import { createRagProvider } from "./rag-provider.js";
import { RuntimeRegistry } from "./runtime-adapter.js";
import { ContextStore } from "./context-store.js";
import { SqliteStateStore } from "./storage/sqlite-state-store.js";

export function createMcpServer(options = {}) {
  const appSettings = options.appSettings || new AppSettingsService();
  const settings = options.settings || appSettings.getSettings();
  let agentOrchestrator = options.agentOrchestrator;
  if (!agentOrchestrator) {
    const client = createAnythingLlmClient({
      baseUrl: settings.ragProviders.anythingllm.baseUrl,
      apiKey: appSettings.getAnythingLlmCredentials().apiKey,
    });
    const ragProvider = createRagProvider({ id: settings.ragProviderId, client });
    const stateStore = new SqliteStateStore({
      databasePath: settings.metadataDbPath,
      resourceRootPath: settings.resourceRootPath,
    });
    const resourceManager = new ResourceManager({
      rootPath: settings.resourceRootPath,
      client: ragProvider,
      metadataRepository: stateStore.repository,
    });
    const runtimeRegistry = new RuntimeRegistry({ settings });
    agentOrchestrator = new AgentOrchestrator({
      client,
      ragProvider,
      resourceManager,
      runtimeRegistry,
      contextStore: new ContextStore({ repository: stateStore.repository }),
      stateStore,
      settings,
    });
  }

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
    "hippo_list_workspaces",
    {
      title: "List workspaces",
      description: "List Hippo workspaces managed under the app system path.",
    },
    async () => jsonContent(await agentOrchestrator.listWorkspaces())
  );

  server.registerTool(
    "hippo_create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a Hippo workspace with optional global agent references, knowledge library refs, and topic filters.",
      inputSchema: strictInput({
        name: z.string().min(1),
        description: z.string().optional(),
        hippoMcpEnabled: z.boolean().default(false),
        agentIds: z.array(z.string()).default([]),
        knowledgeDomainRefs: z.array(z.string()).default([]),
        knowledgeTopicRefs: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (args) => jsonContent(await agentOrchestrator.createWorkspace(args))
  );

  server.registerTool(
    "hippo_get_workspace",
    {
      title: "Get workspace",
      description: "Get a Hippo workspace by id.",
      inputSchema: strictInput({
        workspaceId: z.string().min(1),
      }),
    },
    async ({ workspaceId }) => jsonContent(await agentOrchestrator.getWorkspace(workspaceId))
  );

  server.registerTool(
    "hippo_update_workspace",
    {
      title: "Update workspace",
      description: "Update workspace metadata, enabled global agents, knowledge library refs, and topic filters.",
      inputSchema: strictInput({
        workspaceId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        hippoMcpEnabled: z.boolean().optional(),
        agentIds: z.array(z.string()).optional(),
        knowledgeDomainRefs: z.array(z.string()).optional(),
        knowledgeTopicRefs: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async ({ workspaceId, ...payload }) => jsonContent(await agentOrchestrator.updateWorkspace(workspaceId, payload))
  );

  server.registerTool(
    "hippo_list_agents",
    {
      title: "List agents",
      description: "List global Hippo agent definitions.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => jsonContent(await agentOrchestrator.listAgents())
  );

  server.registerTool(
    "hippo_get_agent_schema",
    {
      title: "Get Agent Blueprint schema",
      description: "Return the canonical versioned JSON Schema used to create, edit, validate, and persist Hippo Agent blueprints.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => jsonContent(agentOrchestrator.getAgentSchema())
  );

  server.registerTool(
    "hippo_create_agent",
    {
      title: "Create agent",
      description: "Create a global agent definition with runtime, skills, MCP access, and behavior description.",
      inputSchema: strictInput({
        $schema: z.literal("https://hippo.local/schemas/agent-blueprint-v1.schema.json").default("https://hippo.local/schemas/agent-blueprint-v1.schema.json"),
        schemaVersion: z.literal(1).default(1),
        type: z.enum(["single", "blueprint"]).default("single"),
        name: z.string().min(1),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(skillInputSchema()).default([]),
        mcpServers: z.array(z.string()).default([]),
        runtimeId: z.string().default("codex"),
        rag: nodeRagInputSchema().optional(),
        rootNodeId: z.string().optional(),
        nodes: z.array(agentNodeInputSchema()).default([]),
        edges: z.array(agentEdgeInputSchema()).default([]),
        executionPolicy: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => jsonContent(await agentOrchestrator.createAgent(args))
  );

  server.registerTool(
    "hippo_validate_agent_graph",
    {
      title: "Validate agent graph",
      description: "Validate a single or Blueprint agent prototype without creating runtime state.",
      inputSchema: strictInput({
        $schema: z.literal("https://hippo.local/schemas/agent-blueprint-v1.schema.json").default("https://hippo.local/schemas/agent-blueprint-v1.schema.json"),
        schemaVersion: z.literal(1).default(1),
        type: z.enum(["single", "blueprint"]).default("single"),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(skillInputSchema()).default([]),
        mcpServers: z.array(z.string()).default([]),
        runtimeId: z.string().default("codex"),
        rag: nodeRagInputSchema().optional(),
        rootNodeId: z.string().optional(),
        nodes: z.array(agentNodeInputSchema()).default([]),
        edges: z.array(agentEdgeInputSchema()).default([]),
        executionPolicy: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => jsonContent(agentOrchestrator.validateAgent(args))
  );

  server.registerTool(
    "hippo_get_agent",
    {
      title: "Get agent",
      description: "Get a global agent definition by id.",
      inputSchema: strictInput({
        agentId: z.string().min(1),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ agentId }) => jsonContent(await agentOrchestrator.getAgent(agentId))
  );

  server.registerTool(
    "hippo_update_agent",
    {
      title: "Update Agent blueprint",
      description: "Edit an existing Agent blueprint. expectedVersion is required to prevent overwriting a newer revision.",
      inputSchema: strictInput({
        agentId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
        $schema: z.literal("https://hippo.local/schemas/agent-blueprint-v1.schema.json").optional(),
        schemaVersion: z.literal(1).optional(),
        type: z.enum(["single", "blueprint"]).optional(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(skillInputSchema()).optional(),
        mcpServers: z.array(z.string()).optional(),
        runtimeId: z.string().min(1).optional(),
        rag: nodeRagInputSchema().optional(),
        rootNodeId: z.string().optional(),
        nodes: z.array(agentNodeInputSchema()).optional(),
        edges: z.array(agentEdgeInputSchema()).optional(),
        executionPolicy: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ agentId, ...payload }) => jsonContent(await agentOrchestrator.updateAgent(agentId, payload))
  );

  server.registerTool(
    "hippo_delete_agent",
    {
      title: "Delete Agent",
      description: "Delete an Agent definition that is not referenced by a workspace.",
      inputSchema: strictInput({ agentId: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ agentId }) => jsonContent(await agentOrchestrator.deleteAgent(agentId))
  );

  server.registerTool(
    "hippo_workspace_knowledge",
    {
      title: "Get workspace knowledge scope",
      description:
        "Return the knowledge libraries, topics, and indexed documents a Hippo workspace is authorized to access.",
      inputSchema: {
        workspaceId: z.string().min(1),
      },
    },
    async ({ workspaceId }) => jsonContent(await agentOrchestrator.getWorkspaceKnowledgeIndex(workspaceId))
  );

  server.registerTool(
    "hippo_sync_knowledge_topic",
    {
      title: "Sync knowledge topic",
      description:
        "Scan a second-level Hippo knowledge topic folder, upload new or changed files to its topic-level RAG workspace, and refresh embeddings.",
      inputSchema: {
        topicPath: z.string().min(1),
        force: z.boolean().default(false),
      },
    },
    async ({ topicPath, force }) => jsonContent(await resourceManager.syncTopicWorkspace(topicPath, { force }))
  );

  server.registerTool(
    "hippo_workspace_rag_plan",
    {
      title: "Plan workspace RAG scope",
      description:
        "Return the authorized knowledge domains/topics and retrieval protocol so a model can choose which topic-level RAG workspaces to search.",
      inputSchema: strictInput({
        workspaceId: z.string().min(1),
        domainRefs: z.array(z.string()).default([]),
        topicRefs: z.array(z.string()).default([]),
      }),
    },
    async ({ workspaceId, domainRefs, topicRefs }) =>
      jsonContent(await agentOrchestrator.getWorkspaceKnowledgePlan(workspaceId, {
        domainRefs,
        topicRefs,
      }))
  );

  server.registerTool(
    "hippo_workspace_rag_search",
    {
      title: "Workspace-scoped RAG search",
      description:
        "Run RAG retrieval through topic-level RAG workspaces, constrained by the Hippo workspace's knowledge refs.",
      inputSchema: strictInput({
        workspaceId: z.string().min(1),
        query: z.string().min(1),
        domainRefs: z.array(z.string()).default([]),
        topicRefs: z.array(z.string()).default([]),
        topN: z.number().int().positive().default(4),
      }),
    },
    async ({ workspaceId, query, domainRefs, topicRefs, topN }) =>
      jsonContent(await agentOrchestrator.searchWorkspaceKnowledge(workspaceId, {
        query,
        domainRefs,
        topicRefs,
        topN,
      }))
  );

  server.registerTool(
    "hippo_execute_workspace_task",
    {
      title: "Execute workspace task",
      description:
        "Execute a task in a Hippo workspace using the selected runtime and an optional workspace-enabled global agent.",
      inputSchema: strictInput({
        workspaceId: z.string().min(1),
        agentId: z.string().optional(),
        task: z.string().min(1),
        sessionId: z.string().optional(),
        dryRun: z.boolean().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
        sandboxMode: z.enum(["workspace-write", "read-only", "danger-full-access"]).optional(),
      }),
    },
    async ({ workspaceId, ...payload }) =>
      jsonContent(await agentOrchestrator.executeAgentTask(workspaceId, payload))
  );

  server.registerTool(
    "hippo_list_agent_runs",
    {
      title: "List agent runs",
      description: "List persisted Hippo agent runs for a workspace, optionally scoped to a root session.",
      inputSchema: {
        workspaceId: z.string().min(1),
        rootSessionId: z.string().optional(),
      },
    },
    async ({ workspaceId, rootSessionId }) =>
      jsonContent(await agentOrchestrator.listAgentRuns(workspaceId, { rootSessionId }))
  );

  server.registerTool(
    "hippo_create_agent_run",
    {
      title: "Create agent run",
      description: "Create a persisted AgentRun with a Root coordinator and an initially empty runtime graph.",
      inputSchema: {
        workspaceId: z.string().min(1),
        agentId: z.string().min(1),
        task: z.string().min(1),
        sessionId: z.string().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
        sandboxMode: z.enum(["workspace-write", "read-only", "danger-full-access"]).optional(),
      },
    },
    async ({ workspaceId, ...payload }) =>
      jsonContent(await agentOrchestrator.createGraphRun(workspaceId, payload))
  );

  server.registerTool(
    "hippo_get_agent_run",
    {
      title: "Get agent run",
      description: "Get a persisted AgentRun, including its frozen agent snapshot and NodeRun state.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
      },
    },
    async ({ workspaceId, runId }) => jsonContent(await agentOrchestrator.getAgentRun(workspaceId, runId))
  );

  server.registerTool(
    "hippo_advance_agent_run",
    {
      title: "Advance agent run",
      description: "Resume the persisted Root coordinator session so it can inspect the runtime graph and decide the next action.",
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
      },
    },
    async ({ workspaceId, runId }) => jsonContent(await agentOrchestrator.advanceGraphRun(workspaceId, runId))
  );

  server.registerTool(
    "hippo_dispatch_graph_node",
    {
      title: "Dispatch graph node",
      description: "Create a new append-only NodeRun attempt and execute it in an isolated runtime session.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        nodeId: z.string().min(1),
        input: z.object({
          nodeTask: z.string().min(1).describe("Concrete subtask assigned to this node without replacing the original user request."),
          relevantContext: z.unknown().optional().describe("Only upstream inputs and outputs relevant to this node."),
          contextRefs: z.array(z.object({
            ref: z.string().regex(/^ctx:\/\//),
            title: z.string().min(1),
            summary: z.string().default(""),
            reason: z.string().default(""),
          }).strict()).default([]).describe("Versioned session context references authorized for this node."),
          requirements: z.array(z.string().min(1)).default([]).describe("Original-request constraints that this node must preserve."),
          expectedArtifacts: z.array(z.object({
            type: z.string().min(1),
            count: z.number().int().positive().optional(),
            description: z.string().optional(),
          }).strict()).default([]).describe("Real deliverables this node must produce; plans and placeholders do not satisfy this contract."),
        }).strict(),
        parentNodeRunId: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ workspaceId, runId, ...payload }) =>
      jsonContent(await agentOrchestrator.dispatchGraphNode(workspaceId, runId, payload))
  );

  server.registerTool(
    "hippo_request_graph_user",
    {
      title: "Request user input for graph run",
      description: "Pause a graph run and expose the Root coordinator's question to the user.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        question: z.string().min(1),
        reason: z.string().optional(),
      },
    },
    async ({ workspaceId, runId, ...payload }) =>
      jsonContent(await agentOrchestrator.requestGraphRunUser(workspaceId, runId, payload))
  );

  server.registerTool(
    "hippo_resume_graph_with_user_input",
    {
      title: "Resume graph run with user input",
      description: "Resume the same Root coordinator session after the user answers its question.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        input: z.unknown(),
      },
    },
    async ({ workspaceId, runId, input }) =>
      jsonContent(await agentOrchestrator.resumeGraphRunWithUserInput(workspaceId, runId, { input }))
  );

  server.registerTool(
    "hippo_complete_graph_run",
    {
      title: "Complete graph run",
      description: "Mark a graph run completed with the Root coordinator's final output.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        output: z.unknown().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ workspaceId, runId, ...payload }) =>
      jsonContent(await agentOrchestrator.completeGraphRun(workspaceId, runId, payload))
  );

  server.registerTool(
    "hippo_fail_graph_run",
    {
      title: "Fail graph run",
      description: "Mark a graph run failed with the Root coordinator's reason.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        output: z.unknown().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ workspaceId, runId, ...payload }) =>
      jsonContent(await agentOrchestrator.failGraphRun(workspaceId, runId, payload))
  );

  server.registerTool(
    "hippo_retry_node_run",
    {
      title: "Retry node run",
      description: "Create a new NodeRun attempt from a previous node run, preserving the previous attempt and trace.",
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        nodeRunId: z.string().optional(),
        nodeId: z.string().optional(),
      },
    },
    async ({ workspaceId, runId, nodeRunId, nodeId }) =>
      jsonContent(await agentOrchestrator.retryNodeRun(workspaceId, runId, { nodeRunId, nodeId }))
  );

  server.registerTool(
    "hippo_resume_node_run",
    {
      title: "Resume waiting node run",
      description: "Resume a waiting Blueprint node by providing human/tool output, then advance the graph.",
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        nodeRunId: z.string().optional(),
        nodeId: z.string().optional(),
        output: z.unknown().optional(),
      },
    },
    async ({ workspaceId, runId, nodeRunId, nodeId, output }) =>
      jsonContent(await agentOrchestrator.resumeNodeRun(workspaceId, runId, { nodeRunId, nodeId, output }))
  );

  server.registerTool(
    "hippo_cancel_agent_run",
    {
      title: "Cancel agent run",
      description: "Cancel a persisted AgentRun and any active runtime process for its running nodes.",
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
      },
    },
    async ({ workspaceId, runId }) => jsonContent(await agentOrchestrator.cancelAgentRun(workspaceId, runId))
  );

  server.registerTool(
    "hippo_get_node_run",
    {
      title: "Get node run",
      description: "Get one NodeRun from a persisted AgentRun.",
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        nodeRunId: z.string().min(1),
      },
    },
    async ({ workspaceId, runId, nodeRunId }) =>
      jsonContent(await agentOrchestrator.getNodeRun(workspaceId, runId, nodeRunId))
  );

  server.registerTool(
    "hippo_list_agent_run_trace",
    {
      title: "List agent run trace",
      description: "List trace events for an AgentRun, or for one node in that run.",
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        nodeRunId: z.string().optional(),
        nodeId: z.string().optional(),
      },
    },
    async ({ workspaceId, runId, nodeRunId, nodeId }) =>
      jsonContent(await agentOrchestrator.listAgentRunTrace(workspaceId, runId, { nodeRunId, nodeId }))
  );

  server.registerTool(
    "hippo_append_agent_run_trace",
    {
      title: "Append agent run trace",
      description: "Append a validated trace event to an AgentRun, optionally scoped to one node run.",
      inputSchema: {
        workspaceId: z.string().min(1),
        runId: z.string().min(1),
        type: z.string().min(1),
        payload: z.unknown().optional(),
        nodeRunId: z.string().optional(),
        nodeId: z.string().optional(),
      },
    },
    async ({ workspaceId, runId, type, payload, nodeRunId, nodeId }) =>
      jsonContent(await agentOrchestrator.appendAgentRunTraceEvent(workspaceId, runId, {
        type,
        payload,
        nodeRunId,
        nodeId,
      }))
  );

  return server;
}

export function createGraphMcpServer({ workspaceId, runId, agentOrchestrator } = {}) {
  if (!workspaceId || !runId || !agentOrchestrator) {
    throw new Error("Graph MCP requires workspaceId, runId, and agentOrchestrator.");
  }
  const server = new McpServer({
    name: "hippo-graph",
    version: "0.1.0",
  });

  server.registerTool(
    "hippo_get_agent_run",
    {
      title: "Get current graph run",
      description: "Read the graph run bound to this Root coordinator, including node states and outputs.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => jsonContent(await agentOrchestrator.getAgentRun(workspaceId, runId))
  );

  server.registerTool(
    "hippo_dispatch_graph_node",
    {
      title: "Dispatch graph node",
      description: "Execute one worker node with a task envelope assembled by the Root coordinator.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: strictInput({
        nodeId: z.string().min(1),
        input: graphDispatchInputSchema(),
        parentNodeRunId: z.string().min(1).optional(),
        reason: z.string().optional(),
      }),
    },
    async (payload) => jsonContent(await agentOrchestrator.dispatchGraphNode(workspaceId, runId, payload))
  );

  server.registerTool(
    "hippo_request_graph_user",
    {
      title: "Request user input",
      description: "Pause the bound graph run and ask the user one necessary question.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: strictInput({
        question: z.string().min(1),
        reason: z.string().optional(),
      }),
    },
    async (payload) => jsonContent(await agentOrchestrator.requestGraphRunUser(workspaceId, runId, payload))
  );

  server.registerTool(
    "hippo_complete_graph_run",
    {
      title: "Complete graph run",
      description: "Complete the bound graph run and assemble its final user-facing output.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: strictInput({
        output: z.unknown().optional(),
        reason: z.string().optional(),
      }),
    },
    async (payload) => jsonContent(await agentOrchestrator.completeGraphRun(workspaceId, runId, payload))
  );

  server.registerTool(
    "hippo_fail_graph_run",
    {
      title: "Fail graph run",
      description: "Fail the bound graph run when it cannot satisfy the original request.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: strictInput({
        output: z.unknown().optional(),
        reason: z.string().min(1),
      }),
    },
    async (payload) => jsonContent(await agentOrchestrator.failGraphRun(workspaceId, runId, payload))
  );

  return server;
}

export function createRagMcpServer({ workspaceId, topN = 4 } = {}) {
  const appSettings = new AppSettingsService();
  const settings = appSettings.getSettings();
  const client = createAnythingLlmClient({
    baseUrl: settings.ragProviders.anythingllm.baseUrl,
    apiKey: appSettings.getAnythingLlmCredentials().apiKey,
  });
  const ragProvider = createRagProvider({ id: settings.ragProviderId, client });
  const stateStore = new SqliteStateStore({
    databasePath: settings.metadataDbPath,
    resourceRootPath: settings.resourceRootPath,
  });
  const resourceManager = new ResourceManager({
    rootPath: settings.resourceRootPath,
    client: ragProvider,
    metadataRepository: stateStore.repository,
  });
  const agentOrchestrator = new AgentOrchestrator({
    client,
    ragProvider,
    resourceManager,
    runtimeRegistry: new RuntimeRegistry({ settings }),
    contextStore: new ContextStore({ repository: stateStore.repository }),
    stateStore,
    settings,
  });
  const retrievalLimit = Math.max(1, Number(topN) || 4);
  const server = new McpServer({ name: "hippo-rag", version: "0.1.0" });

  server.registerTool(
    "hippo_rag_scope",
    {
      title: "Get authorized RAG scope",
      description: "Return the knowledge domains and topics authorized for the current Hippo workspace.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => jsonContent(await agentOrchestrator.getWorkspaceKnowledgePlan(workspaceId, {}))
  );

  server.registerTool(
    "hippo_rag_list_documents",
    {
      title: "List authorized knowledge documents",
      description: "List documents under selected authorized domains/topics. Returns a knowledge root path and relative document paths.",
      inputSchema: strictInput({
        domainRefs: z.array(z.string().min(1)).default([]),
        topicRefs: z.array(z.string().min(1)).default([]),
        suffixes: z.array(z.string().min(1)).default([]),
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) => jsonContent(await agentOrchestrator.listWorkspaceKnowledgeDocuments(workspaceId, args))
  );

  server.registerTool(
    "hippo_rag_search",
    {
      title: "Search authorized workspace knowledge",
      description: `Search selected authorized knowledge topics. Each result includes its accessible Hippo knowledge file path when the source can be resolved. The node retrieval limit is fixed at Top ${retrievalLimit}.`,
      inputSchema: strictInput({
        query: z.string().min(1),
        topicRefs: z.array(z.string()).default([]),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, topicRefs }) => jsonContent(await agentOrchestrator.searchWorkspaceKnowledge(workspaceId, {
      query,
      topicRefs,
      topN: retrievalLimit,
    }))
  );

  return server;
}

export function createContextMcpServer({
  workspaceId,
  sessionId,
  runId = "",
  nodeRunId = "",
  role = "root",
  agentOrchestrator,
  contextStore,
} = {}) {
  if (!agentOrchestrator) throw new Error("Context MCP requires an AgentOrchestrator instance.");
  contextStore ||= agentOrchestrator.contextStore;
  if (!contextStore) throw new Error("Context MCP requires a ContextStore instance.");
  const server = new McpServer({ name: "hippo-context", version: "0.1.0" });

  server.registerTool(
    "hippo_context_write",
    {
      title: "Write session context",
      description: "Write a versioned context item under the current Hippo workspace and session. Returns a stable ctx:// reference. Long node results should be written here and passed by reference.",
      inputSchema: strictInput({
        ref: z.string().optional().describe("Existing ctx:// reference to update. Omit to create a new item."),
        title: z.string().min(1),
        summary: z.string().max(2000).default(""),
        content: z.string().min(1),
        contentType: z.enum(["text/markdown", "text/plain", "application/json"]).default("text/markdown"),
        tags: z.array(z.string().min(1)).max(50).default([]),
        expectedVersion: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const scope = await resolveContextMcpScope({ workspaceId, sessionId, runId, nodeRunId, role, agentOrchestrator });
      if (input.ref) await assertContextWriteAllowed(contextStore, scope, input.ref);
      return jsonContent(await contextStore.write({
        workspacePath: scope.workspace.localWorkspacePath,
        sessionId,
        ...input,
        source: {
          role: scope.role,
          runId: scope.runId,
          nodeId: scope.nodeId,
          agentId: scope.agentId,
        },
      }));
    }
  );

  server.registerTool(
    "hippo_context_read",
    {
      title: "Read session context",
      description: "Resolve an authorized ctx:// reference and read only the requested range or Markdown sections.",
      inputSchema: strictInput({
        ref: z.string().min(1),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(100000).default(20000),
        headings: z.array(z.string().min(1)).max(50).default([]),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const scope = await resolveContextMcpScope({ workspaceId, sessionId, runId, nodeRunId, role, agentOrchestrator });
      await assertContextReadAllowed(contextStore, scope, input.ref);
      return jsonContent(await contextStore.read({ workspacePath: scope.workspace.localWorkspacePath, sessionId, ...input }));
    }
  );

  server.registerTool(
    "hippo_context_list",
    {
      title: "List session context",
      description: "List context references visible to the current Root or worker node without loading their full content.",
      inputSchema: strictInput({
        tags: z.array(z.string().min(1)).max(50).default([]),
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const scope = await resolveContextMcpScope({ workspaceId, sessionId, runId, nodeRunId, role, agentOrchestrator });
      return jsonContent(await contextStore.list({
        workspacePath: scope.workspace.localWorkspacePath,
        sessionId,
        ...input,
        ...(scope.role === "node" ? { refs: scope.allowedRefs } : {}),
      }));
    }
  );

  server.registerTool(
    "hippo_context_search",
    {
      title: "Search session context",
      description: "Search titles, summaries, tags, and content within the current authorized context scope. Read the referenced source before making a critical decision.",
      inputSchema: strictInput({
        query: z.string().min(1),
        tags: z.array(z.string().min(1)).max(50).default([]),
        page: z.number().int().positive().default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const scope = await resolveContextMcpScope({ workspaceId, sessionId, runId, nodeRunId, role, agentOrchestrator });
      return jsonContent(await contextStore.search({
        workspacePath: scope.workspace.localWorkspacePath,
        sessionId,
        ...input,
        ...(scope.role === "node" ? { refs: scope.allowedRefs } : {}),
      }));
    }
  );

  return server;
}

async function resolveContextMcpScope({ workspaceId, sessionId, runId, nodeRunId, role, agentOrchestrator }) {
  const { workspace } = await agentOrchestrator.getWorkspace(workspaceId);
  if (!workspace.localWorkspacePath) throw new Error("Workspace has no local path.");
  if (!sessionId) throw new Error("Context sessionId is required.");
  if (role !== "node") {
    let agentId = "";
    if (runId) {
      const { run } = await agentOrchestrator.getAgentRun(workspaceId, runId);
      if (run.rootSessionId !== sessionId) throw new Error("Context session does not match the Agent Run.");
      agentId = run.agentId || "";
    }
    return { workspace, sessionId, role: "root", runId, nodeId: "root", agentId, allowedRefs: undefined };
  }
  if (!runId || !nodeRunId) throw new Error("Node context scope requires runId and nodeRunId.");
  const { run, nodeRun } = await agentOrchestrator.getNodeRun(workspaceId, runId, nodeRunId);
  if (run.rootSessionId !== sessionId) throw new Error("Context session does not match the Agent Run.");
  const grantedRefs = Array.isArray(nodeRun.input?.contextRefs) ? nodeRun.input.contextRefs : [];
  const own = (await contextStoreForNodeItems(workspace, sessionId, runId, nodeRunId, agentOrchestrator, nodeRun)).items || [];
  return {
    workspace,
    sessionId,
    role: "node",
    runId,
    nodeId: nodeRunId,
    agentId: run.agentId || "",
    allowedRefs: [...grantedRefs, ...own.map((item) => item.ref)],
  };
}

async function contextStoreForNodeItems(workspace, sessionId, runId, nodeRunId, agentOrchestrator, nodeRun) {
  const store = agentOrchestrator.contextStore;
  if (!store) return { items: [] };
  return store.list({ workspacePath: workspace.localWorkspacePath, sessionId, sourceRunId: runId, sourceNodeId: nodeRunId, pageSize: 100 });
}

async function assertContextReadAllowed(contextStore, scope, ref) {
  if (scope.role !== "node") return contextStore.assertReadable({ workspacePath: scope.workspace.localWorkspacePath, sessionId: scope.sessionId, ref });
  return contextStore.assertReadable({
    workspacePath: scope.workspace.localWorkspacePath,
    sessionId: scope.sessionId,
    ref,
    allowedRefs: scope.allowedRefs,
  });
}

async function assertContextWriteAllowed(contextStore, scope, ref) {
  if (scope.role !== "node") return contextStore.assertReadable({ workspacePath: scope.workspace.localWorkspacePath, sessionId: scope.sessionId, ref });
  const current = await contextStore.read({ workspacePath: scope.workspace.localWorkspacePath, sessionId: scope.sessionId, ref, limit: 1 });
  if (current.source?.runId !== scope.runId || current.source?.nodeId !== scope.nodeId) {
    throw new Error("Worker nodes can only update context items they created.");
  }
}

function skillInputSchema() {
  return z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    instructions: z.string().optional(),
  }).strict();
}

function agentNodeInputSchema() {
  return z.object({
    id: z.string().min(1),
    kind: z.enum(["task"]).default("task"),
    resultApprovalPolicy: z.enum(["none", "auto", "manual"]).optional(),
    runtimeApprovalPolicy: z.enum(["inherit", "untrusted", "on-request", "never"]).default("inherit"),
    transitionInstruction: z.string().optional().describe("Plain-language result handling rule shown to RootAgent together with this node's output."),
    name: z.string().min(1).optional(),
    description: z.string().optional().describe("External interface description used by RootAgent to decide when and how to dispatch this node."),
    agentId: z.string().optional(),
    systemPrompt: z.string().optional().describe("System prompt used by the worker runtime when this node executes."),
    runtimeId: z.string().optional(),
    rag: nodeRagInputSchema().optional(),
    skills: z.array(skillInputSchema()).default([]),
    mcpServers: z.array(z.string()).default([]),
    input: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict();
}

function nodeRagInputSchema() {
  return z.object({
    enabled: z.boolean().default(false),
    topN: z.number().int().min(1).max(100).default(4),
  }).strict();
}

function graphDispatchInputSchema() {
  return z.object({
    nodeTask: z.string().min(1).describe("Concrete subtask assigned to this node."),
    relevantContext: z.unknown().optional().describe("Only the upstream facts and outputs needed by this node."),
    contextRefs: z.array(z.object({
      ref: z.string().regex(/^ctx:\/\//),
      title: z.string().min(1),
      summary: z.string().default(""),
      reason: z.string().default(""),
    }).strict()).default([]),
    requirements: z.array(z.string().min(1)).default([]),
    expectedArtifacts: z.array(z.object({
      type: z.string().min(1),
      count: z.number().int().positive().optional(),
      description: z.string().optional(),
    }).strict()).default([]),
  }).strict();
}

function agentEdgeInputSchema() {
  return z.object({
    id: z.string().optional(),
    from: z.string().min(1),
    to: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict();
}

function strictInput(shape) {
  return z.object(shape).strict();
}
