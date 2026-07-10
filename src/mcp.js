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
  const resourceManager = new ResourceManager({ rootPath: settings.resourceRootPath, client: ragProvider });
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
      title: "List workspaces",
      description: "List Hippo workspaces managed under the app system path.",
    },
    async () => {
      return jsonContent(await agentOrchestrator.listProjects());
    }
  );

  server.registerTool(
    "hippo_list_workspaces",
    {
      title: "List workspaces",
      description: "List Hippo workspaces managed under the app system path.",
    },
    async () => jsonContent(await agentOrchestrator.listProjects())
  );

  server.registerTool(
    "hippo_create_project",
    {
      title: "Create workspace",
      description:
        "Create a Hippo workspace with optional global agent references, knowledge library refs, and topic filters.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        agentIds: z.array(z.string()).default([]),
        knowledgeDrawerRefs: z.array(z.string()).default([]),
        knowledgeTopicRefs: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      return jsonContent(await agentOrchestrator.createProject(args));
    }
  );

  server.registerTool(
    "hippo_create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a Hippo workspace with optional global agent references, knowledge library refs, and topic filters.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        agentIds: z.array(z.string()).default([]),
        knowledgeDrawerRefs: z.array(z.string()).default([]),
        knowledgeTopicRefs: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => jsonContent(await agentOrchestrator.createProject(args))
  );

  server.registerTool(
    "hippo_get_project",
    {
      title: "Get workspace",
      description: "Get a Hippo workspace by id.",
      inputSchema: {
        projectId: z.string().min(1),
      },
    },
    async ({ projectId }) => {
      return jsonContent(await agentOrchestrator.getProject(projectId));
    }
  );

  server.registerTool(
    "hippo_get_workspace",
    {
      title: "Get workspace",
      description: "Get a Hippo workspace by id.",
      inputSchema: {
        workspaceId: z.string().min(1),
      },
    },
    async ({ workspaceId }) => jsonContent(await agentOrchestrator.getProject(workspaceId))
  );

  server.registerTool(
    "hippo_update_project",
    {
      title: "Update workspace",
      description: "Update workspace metadata, enabled global agents, knowledge library refs, and topic filters.",
      inputSchema: {
        projectId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        agentIds: z.array(z.string()).optional(),
        knowledgeDrawerRefs: z.array(z.string()).optional(),
        knowledgeTopicRefs: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ projectId, ...payload }) => {
      return jsonContent(await agentOrchestrator.updateProject(projectId, payload));
    }
  );

  server.registerTool(
    "hippo_update_workspace",
    {
      title: "Update workspace",
      description: "Update workspace metadata, enabled global agents, knowledge library refs, and topic filters.",
      inputSchema: {
        workspaceId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        agentIds: z.array(z.string()).optional(),
        knowledgeDrawerRefs: z.array(z.string()).optional(),
        knowledgeTopicRefs: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ workspaceId, ...payload }) => jsonContent(await agentOrchestrator.updateProject(workspaceId, payload))
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
        type: z.enum(["single", "dag"]).default("single"),
        name: z.string().min(1),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
        skills: z.array(skillInputSchema()).default([]),
        mcpServers: z.array(z.string()).default([]),
        runtimeId: z.string().default("codex"),
        ragDocumentNames: z.array(z.string()).default([]),
        rag: nodeRagInputSchema().optional(),
        rootNodeId: z.string().optional(),
        nodes: z.array(agentNodeInputSchema()).default([]),
        edges: z.array(agentEdgeInputSchema()).default([]),
        executionPolicy: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => jsonContent(await agentOrchestrator.createAgent(args))
  );

  server.registerTool(
    "hippo_validate_agent_graph",
    {
      title: "Validate agent graph",
      description: "Validate a single or DAG agent prototype without creating runtime state.",
      inputSchema: {
        type: z.enum(["single", "dag"]).default("single"),
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
      },
    },
    async (args) => jsonContent(agentOrchestrator.validateAgent(args))
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
      title: "Get workspace knowledge scope",
      description:
        "Return the knowledge libraries, topics, and indexed documents a Hippo workspace is authorized to access.",
      inputSchema: {
        projectId: z.string().min(1),
      },
    },
    async ({ projectId }) => {
      return jsonContent(await agentOrchestrator.getProjectKnowledgeIndex(projectId));
    }
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
    async ({ workspaceId }) => jsonContent(await agentOrchestrator.getProjectKnowledgeIndex(workspaceId))
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
    "hippo_project_rag_plan",
    {
      title: "Plan workspace RAG scope",
      description:
        "Return the authorized knowledge domains/topics and retrieval protocol so a model can choose which topic-level RAG workspaces to search.",
      inputSchema: {
        projectId: z.string().min(1),
        drawerRefs: z.array(z.string()).default([]),
        domainRefs: z.array(z.string()).default([]),
        topicRefs: z.array(z.string()).default([]),
      },
    },
    async ({ projectId, drawerRefs, domainRefs, topicRefs }) =>
      jsonContent(await agentOrchestrator.getProjectKnowledgePlan(projectId, {
        drawerRefs,
        domainRefs,
        topicRefs,
      }))
  );

  server.registerTool(
    "hippo_workspace_rag_plan",
    {
      title: "Plan workspace RAG scope",
      description:
        "Return the authorized knowledge domains/topics and retrieval protocol so a model can choose which topic-level RAG workspaces to search.",
      inputSchema: {
        workspaceId: z.string().min(1),
        drawerRefs: z.array(z.string()).default([]),
        domainRefs: z.array(z.string()).default([]),
        topicRefs: z.array(z.string()).default([]),
      },
    },
    async ({ workspaceId, drawerRefs, domainRefs, topicRefs }) =>
      jsonContent(await agentOrchestrator.getProjectKnowledgePlan(workspaceId, {
        drawerRefs,
        domainRefs,
        topicRefs,
      }))
  );

  server.registerTool(
    "hippo_project_rag_search",
    {
      title: "Workspace-scoped RAG search",
      description:
        "Run RAG retrieval through topic-level RAG workspaces, constrained by the Hippo workspace's knowledge refs.",
      inputSchema: {
        projectId: z.string().min(1),
        query: z.string().min(1),
        drawerRefs: z.array(z.string()).default([]),
        domainRefs: z.array(z.string()).default([]),
        topicRefs: z.array(z.string()).default([]),
        topN: z.number().int().positive().default(4),
        scoreThreshold: z.number().min(0).max(1).optional(),
      },
    },
    async ({ projectId, query, drawerRefs, domainRefs, topicRefs, topN, scoreThreshold }) =>
      jsonContent(await agentOrchestrator.searchProjectKnowledge(projectId, {
        query,
        drawerRefs,
        domainRefs,
        topicRefs,
        topN,
        scoreThreshold,
      }))
  );

  server.registerTool(
    "hippo_workspace_rag_search",
    {
      title: "Workspace-scoped RAG search",
      description:
        "Run RAG retrieval through topic-level RAG workspaces, constrained by the Hippo workspace's knowledge refs.",
      inputSchema: {
        workspaceId: z.string().min(1),
        query: z.string().min(1),
        drawerRefs: z.array(z.string()).default([]),
        domainRefs: z.array(z.string()).default([]),
        topicRefs: z.array(z.string()).default([]),
        topN: z.number().int().positive().default(4),
        scoreThreshold: z.number().min(0).max(1).optional(),
      },
    },
    async ({ workspaceId, query, drawerRefs, domainRefs, topicRefs, topN, scoreThreshold }) =>
      jsonContent(await agentOrchestrator.searchProjectKnowledge(workspaceId, {
        query,
        drawerRefs,
        domainRefs,
        topicRefs,
        topN,
        scoreThreshold,
      }))
  );

  server.registerTool(
    "hippo_execute_project_task",
    {
      title: "Execute workspace task",
      description:
        "Execute a task in a Hippo workspace using the selected runtime and an optional workspace-enabled global agent.",
      inputSchema: {
        projectId: z.string().min(1),
        agentId: z.string().optional(),
        task: z.string().min(1),
        mode: z.enum(["query", "chat", "automatic"]).optional(),
        sessionId: z.string().optional(),
        reset: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
        contextStrategy: z.enum(["runtime", "reset", "manual-summary"]).optional(),
        contextSummary: z.string().optional(),
        sandboxMode: z.enum(["workspace-write", "read-only", "danger-full-access"]).optional(),
        knowledgeTags: z.array(z.string()).default([]),
      },
    },
    async ({ projectId, ...payload }) =>
      jsonContent(await agentOrchestrator.executeAgentTask(projectId, payload))
  );

  server.registerTool(
    "hippo_execute_workspace_task",
    {
      title: "Execute workspace task",
      description:
        "Execute a task in a Hippo workspace using the selected runtime and an optional workspace-enabled global agent.",
      inputSchema: {
        workspaceId: z.string().min(1),
        agentId: z.string().optional(),
        task: z.string().min(1),
        mode: z.enum(["query", "chat", "automatic"]).optional(),
        sessionId: z.string().optional(),
        reset: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        context: z.record(z.string(), z.unknown()).optional(),
        contextStrategy: z.enum(["runtime", "reset", "manual-summary"]).optional(),
        contextSummary: z.string().optional(),
        sandboxMode: z.enum(["workspace-write", "read-only", "danger-full-access"]).optional(),
        knowledgeTags: z.array(z.string()).default([]),
      },
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
        contextStrategy: z.enum(["runtime", "reset", "manual-summary"]).optional(),
        contextSummary: z.string().optional(),
        sandboxMode: z.enum(["workspace-write", "read-only", "danger-full-access"]).optional(),
        knowledgeTags: z.array(z.string()).default([]),
        knowledgeTopicRefs: z.array(z.string()).default([]),
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
        input: z.unknown().optional(),
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
      description: "Resume a waiting DAG node by providing human/tool output, then advance the graph.",
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

export function createRagMcpServer({ workspaceId, topN = 4 } = {}) {
  const client = createAnythingLlmClient();
  const appSettings = new AppSettingsService();
  const settings = appSettings.getSettings();
  const ragProvider = createRagProvider({ id: settings.ragProviderId, client });
  const resourceManager = new ResourceManager({ rootPath: settings.resourceRootPath, client: ragProvider });
  const agentOrchestrator = new AgentOrchestrator({
    client,
    ragProvider,
    resourceManager,
    runtimeRegistry: new RuntimeRegistry({ settings }),
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
    async () => jsonContent(await agentOrchestrator.getProjectKnowledgePlan(workspaceId, {}))
  );

  server.registerTool(
    "hippo_rag_search",
    {
      title: "Search authorized workspace knowledge",
      description: `Search selected authorized knowledge topics. The node retrieval limit is fixed at Top ${retrievalLimit}.`,
      inputSchema: {
        query: z.string().min(1),
        topicRefs: z.array(z.string()).default([]),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, topicRefs }) => jsonContent(await agentOrchestrator.searchProjectKnowledge(workspaceId, {
      query,
      topicRefs,
      topN: retrievalLimit,
    }))
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

function agentNodeInputSchema() {
  return z.object({
    id: z.string().min(1),
    kind: z.enum(["task"]).default("task"),
    approvalPolicy: z.enum(["none", "auto", "manual"]).optional(),
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
  });
}

function nodeRagInputSchema() {
  return z.object({
    enabled: z.boolean().default(false),
    topN: z.number().int().positive().default(4),
  });
}

function agentEdgeInputSchema() {
  return z.object({
    id: z.string().optional(),
    from: z.string().min(1),
    to: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
}
