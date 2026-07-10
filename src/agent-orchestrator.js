import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { RuntimeRegistry } from "./runtime-adapter.js";

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
});

const agentNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["task", "wait"]).default("task"),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  agentId: z.string().optional(),
  systemPrompt: z.string().optional(),
  runtimeId: z.string().min(1).optional(),
  skills: z.array(skillSchema).default([]),
  mcpServers: z.array(z.string().min(1)).default([]),
  input: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const agentEdgeSchema = z.object({
  id: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(["serial", "parallel"]).default("serial"),
  required: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  agentIds: z.array(z.string().min(1)).default([]),
  knowledgeDrawerRefs: z.array(z.string().min(1)).default([]),
  knowledgeTopicRefs: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  agentIds: z.array(z.string().min(1)).optional(),
  knowledgeDrawerRefs: z.array(z.string().min(1)).optional(),
  knowledgeTopicRefs: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  runId: z.string().optional(),
  agentRunSummary: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
});

const createConversationSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  messages: z.array(messageSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateConversationSchema = z.object({
  title: z.string().optional(),
  messages: z.array(messageSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createAgentSchema = z.object({
  type: z.enum(["single", "dag"]).default("single"),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(skillSchema).default([]),
  mcpServers: z.array(z.string().min(1)).default([]),
  runtimeId: z.string().min(1).default(config.defaultRuntimeId),
  ragDocumentNames: z.array(z.string().min(1)).default([]),
  defaultMode: z.enum(["query", "chat", "automatic"]).default("query"),
  topN: z.number().int().positive().default(4),
  scoreThreshold: z.number().min(0).max(1).optional(),
  rag: z.record(z.string(), z.unknown()).optional(),
  rootNodeId: z.string().optional(),
  nodes: z.array(agentNodeSchema).default([]),
  edges: z.array(agentEdgeSchema).default([]),
  executionPolicy: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateAgentSchema = createAgentSchema.partial().extend({
  skills: z.array(skillSchema).optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
  runtimeId: z.string().min(1).optional(),
  ragDocumentNames: z.array(z.string().min(1)).optional(),
  nodes: z.array(agentNodeSchema).optional(),
  edges: z.array(agentEdgeSchema).optional(),
});

const executeAgentTaskSchema = z.object({
  task: z.string().min(1),
  agentId: z.string().optional(),
  mode: z.enum(["query", "chat", "automatic"]).optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  reset: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  contextStrategy: z.enum(["runtime", "reset", "manual-summary"]).optional(),
  contextSummary: z.string().optional(),
  sandboxMode: z.enum(["workspace-write", "read-only", "danger-full-access"]).optional(),
  knowledgeTags: z.array(z.string().min(1)).default([]),
  knowledgeTopicRefs: z.array(z.string().min(1)).default([]),
});

const retryNodeRunSchema = z.object({
  nodeRunId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
});

const resumeNodeRunSchema = z.object({
  nodeRunId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  output: z.unknown().optional(),
});

const appendTraceSchema = z.object({
  type: z.string().min(1),
  payload: z.unknown().optional(),
  nodeRunId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
});

export class AgentOrchestrator {
  constructor({
    client,
    ragProvider,
    resourceManager,
    runtimeRegistry,
    settings = {},
    storePath = config.agentStorePath,
  }) {
    this.client = client;
    this.ragProvider = ragProvider || client;
    this.resourceManager = resourceManager;
    this.runtimeRegistry = runtimeRegistry || new RuntimeRegistry({ settings });
    this.settings = settings;
    this.storePath = storePath;
    this.storeLock = Promise.resolve();
  }

  async listProjects() {
    const store = await this.readStore();
    return { projects: store.projects };
  }

  async listAgents() {
    const store = await this.readStore();
    return { agents: store.agents };
  }

  async getAgent(id) {
    const store = await this.readStore();
    const agent = store.agents.find((item) => item.id === id);
    if (!agent) throw new AgentOrchestratorError(`Agent ${id} was not found.`, 404);
    return { agent };
  }

  validateAgent(input) {
    const payload = createAgentSchema.partial().parse(input);
    const agent = normalizeAgent({
      id: payload.id || "candidate",
      name: payload.name || "Candidate Agent",
      ...payload,
    });
    validateAgentPrototype(agent);
    return { valid: true, agent };
  }

  async createAgent(input) {
    const payload = createAgentSchema.parse(input);
    validateAgentPrototype(payload);
    const store = await this.readStore();
    const now = new Date().toISOString();
    const agent = {
      id: randomUUID(),
      type: payload.type,
      version: 1,
      name: payload.name,
      description: payload.description || "",
      systemPrompt: payload.systemPrompt || "",
      skills: payload.skills,
      mcpServers: dedupe(payload.mcpServers),
      runtimeId: payload.runtimeId,
      explicitRagDocumentNames: dedupe(payload.ragDocumentNames),
      ragDocumentNames: dedupe(payload.ragDocumentNames),
      defaultMode: payload.defaultMode,
      topN: payload.topN,
      scoreThreshold: payload.scoreThreshold,
      rag: payload.rag || {},
      rootNodeId: payload.type === "dag" ? payload.rootNodeId || payload.nodes[0]?.id || "" : "",
      nodes: payload.type === "dag" ? normalizeAgentNodes(payload.nodes) : [],
      edges: payload.type === "dag" ? normalizeAgentEdges(payload.edges) : [],
      executionPolicy: payload.executionPolicy || {},
      metadata: payload.metadata || {},
      createdAt: now,
      updatedAt: now,
    };
    store.agents.push(agent);
    await this.writeStore(store);
    return { agent };
  }

  async updateAgent(id, input) {
    const payload = updateAgentSchema.parse(input);
    const store = await this.readStore();
    const index = store.agents.findIndex((item) => item.id === id);
    if (index === -1) throw new AgentOrchestratorError(`Agent ${id} was not found.`, 404);
    const current = store.agents[index];
    const explicitDocs = payload.ragDocumentNames || current.explicitRagDocumentNames || [];
    const candidate = {
      ...current,
      ...definedOnly({
        type: payload.type,
        name: payload.name,
        description: payload.description,
        systemPrompt: payload.systemPrompt,
        skills: payload.skills,
        mcpServers: payload.mcpServers,
        runtimeId: payload.runtimeId,
        defaultMode: payload.defaultMode,
        topN: payload.topN,
        scoreThreshold: payload.scoreThreshold,
        rag: payload.rag,
        rootNodeId: payload.rootNodeId,
        nodes: payload.nodes,
        edges: payload.edges,
        executionPolicy: payload.executionPolicy,
        metadata: payload.metadata,
      }),
      explicitRagDocumentNames: dedupe(explicitDocs),
      ragDocumentNames: dedupe(explicitDocs),
    };
    validateAgentPrototype(candidate);
    const updated = {
      ...candidate,
      version: Number(current.version || 1) + 1,
      rootNodeId: candidate.type === "dag" ? candidate.rootNodeId || candidate.nodes?.[0]?.id || "" : "",
      nodes: candidate.type === "dag" ? normalizeAgentNodes(candidate.nodes) : [],
      edges: candidate.type === "dag" ? normalizeAgentEdges(candidate.edges) : [],
      updatedAt: new Date().toISOString(),
    };
    store.agents[index] = updated;
    await this.writeStore(store);
    return { agent: updated };
  }

  async deleteAgent(id) {
    const store = await this.readStore();
    const next = store.agents.filter((item) => item.id !== id);
    if (next.length === store.agents.length) {
      throw new AgentOrchestratorError(`Agent ${id} was not found.`, 404);
    }
    store.agents = next;
    await this.writeStore(store);
    return { deleted: true, id };
  }

  async getProject(id) {
    const store = await this.readStore();
    const project = store.projects.find((item) => item.id === id);
    if (!project) throw new AgentOrchestratorError(`Workspace ${id} was not found.`, 404);
    return { project };
  }

  async listConversations(projectId) {
    const store = await this.readStore();
    this.findProject(store, projectId);
    const conversations = store.conversations
      .filter((conversation) => conversation.projectId === projectId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return { conversations };
  }

  async getConversation(projectId, conversationId) {
    const store = await this.readStore();
    this.findProject(store, projectId);
    const conversation = store.conversations.find((item) =>
      item.projectId === projectId && item.id === conversationId
    );
    if (!conversation) {
      throw new AgentOrchestratorError(`Conversation ${conversationId} was not found.`, 404);
    }
    return { conversation };
  }

  async createConversation(projectId, input = {}) {
    const payload = createConversationSchema.parse(input);
    const store = await this.readStore();
    this.findProject(store, projectId);
    const now = new Date().toISOString();
    const conversation = {
      id: payload.id || randomUUID(),
      type: "root",
      projectId,
      title: payload.title || deriveConversationTitle(payload.messages) || "新对话",
      messages: normalizeMessages(payload.messages),
      activeAgentId: payload.metadata?.activeAgentId || "",
      runtimeSessions: normalizeRuntimeSessions(payload.metadata?.runtimeSessions),
      runIds: [],
      metadata: payload.metadata || {},
      createdAt: now,
      updatedAt: now,
    };
    store.conversations.push(conversation);
    await this.writeStore(store);
    return { conversation };
  }

  async updateConversation(projectId, conversationId, input = {}) {
    const payload = updateConversationSchema.parse(input);
    const store = await this.readStore();
    this.findProject(store, projectId);
    const index = store.conversations.findIndex((item) =>
      item.projectId === projectId && item.id === conversationId
    );
    if (index === -1) {
      throw new AgentOrchestratorError(`Conversation ${conversationId} was not found.`, 404);
    }
    const current = store.conversations[index];
    const messages = payload.messages ? normalizeMessages(payload.messages) : current.messages;
    const metadata = payload.metadata ? { ...(current.metadata || {}), ...payload.metadata } : current.metadata;
    const updated = {
      ...current,
      ...definedOnly({
        title: payload.title || deriveConversationTitle(messages),
        messages: payload.messages ? messages : undefined,
        activeAgentId: payload.metadata?.activeAgentId,
        runtimeSessions: payload.metadata?.runtimeSessions
          ? normalizeRuntimeSessions(payload.metadata.runtimeSessions)
          : undefined,
        metadata,
      }),
      updatedAt: new Date().toISOString(),
    };
    store.conversations[index] = updated;
    await this.writeStore(store);
    return { conversation: updated };
  }

  async deleteConversation(projectId, conversationId) {
    const store = await this.readStore();
    this.findProject(store, projectId);
    const next = store.conversations.filter((item) =>
      !(item.projectId === projectId && item.id === conversationId)
    );
    if (next.length === store.conversations.length) {
      throw new AgentOrchestratorError(`Conversation ${conversationId} was not found.`, 404);
    }
    store.conversations = next;
    await this.writeStore(store);
    return { deleted: true, id: conversationId };
  }

  async listAgentRuns(projectId, filters = {}) {
    const store = await this.readStore();
    this.findProject(store, projectId);
    const runs = store.agentRuns
      .filter((run) => run.workspaceId === projectId)
      .filter((run) => !filters.rootSessionId || run.rootSessionId === filters.rootSessionId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return { runs };
  }

  async getAgentRun(projectId, runId) {
    const store = await this.readStore();
    this.findProject(store, projectId);
    const run = store.agentRuns.find((item) => item.workspaceId === projectId && item.id === runId);
    if (!run) throw new AgentOrchestratorError(`Agent run ${runId} was not found.`, 404);
    return { run };
  }

  async getNodeRun(projectId, runId, nodeRunId) {
    const { run } = await this.getAgentRun(projectId, runId);
    const nodeRun = run.nodeRuns?.[nodeRunId] || Object.values(run.nodeRuns || {}).find((item) => item.nodeId === nodeRunId);
    if (!nodeRun) throw new AgentOrchestratorError(`Node run ${nodeRunId} was not found.`, 404);
    return { run, nodeRun };
  }

  async listAgentRunTrace(projectId, runId, input = {}) {
    const { run } = await this.getAgentRun(projectId, runId);
    if (input.nodeRunId || input.nodeId) {
      const nodeRun = input.nodeRunId
        ? run.nodeRuns?.[input.nodeRunId]
        : Object.values(run.nodeRuns || {}).find((item) => item.nodeId === input.nodeId);
      if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
      return { trace: nodeRun.trace || [], run, nodeRun };
    }
    return { trace: run.trace || [], run };
  }

  async appendAgentRunTraceEvent(projectId, runId, input = {}) {
    const payload = appendTraceSchema.parse(input);
    return this.updateAgentRun(projectId, runId, (run, now) => {
      const trace = createTrace(payload.type, payload.payload, now);
      run.trace.push(trace);
      if (payload.nodeRunId || payload.nodeId) {
        const nodeRun = payload.nodeRunId
          ? run.nodeRuns?.[payload.nodeRunId]
          : Object.values(run.nodeRuns || {}).find((item) => item.nodeId === payload.nodeId);
        if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
        nodeRun.trace.push(trace);
        nodeRun.updatedAt = now;
      }
      return run;
    });
  }

  async createGraphRun(id, input) {
    const prepared = await this.prepareAgentTask(id, input);
    const { payload, project, agent, request, retrieval, rootSession } = prepared;
    if (agent?.type !== "dag") {
      throw new AgentOrchestratorError("Graph runs require a DAG agent.", 400);
    }
    const agentRun = await this.createAgentRun(project, rootSession, agent, request, {
      input: { task: payload.task, context: payload.context || {} },
      retrieval,
    });
    return { project, agent, request, retrieval, agentRun };
  }

  async advanceGraphRun(projectId, runId) {
    const { project } = await this.getProject(projectId);
    const { run } = await this.getAgentRun(projectId, runId);
    if (run.agentSnapshot?.type !== "dag") {
      throw new AgentOrchestratorError("Only DAG agent runs can be advanced.", 400);
    }
    const request = run.request || {
      runtimeId: run.agentSnapshot.runtimeId || config.defaultRuntimeId,
      runId: run.id,
      projectId,
      mode: run.agentSnapshot.defaultMode || "chat",
      message: run.input?.task || "",
      sessionId: run.rootSessionId,
      reset: true,
    };
    const updated = await this.runDagToCompletion(project, run.agentSnapshot, request, runId);
    return { project, run: updated.run };
  }

  async retryNodeRun(projectId, runId, input = {}) {
    const payload = retryNodeRunSchema.parse(input);
    const { run } = await this.getAgentRun(projectId, runId);
    const nodeRun = payload.nodeRunId
      ? run.nodeRuns?.[payload.nodeRunId]
      : Object.values(run.nodeRuns || {}).find((item) => item.nodeId === payload.nodeId);
    if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
    await this.updateAgentRun(projectId, runId, (current, now) => {
      const currentNode = current.nodeRuns[nodeRun.id];
      currentNode.status = upstreamCompleted(current, currentNode) ? "ready" : "pending";
      currentNode.output = undefined;
      currentNode.error = undefined;
      currentNode.runtimeSession = undefined;
      currentNode.runtimeRunId = "";
      currentNode.updatedAt = now;
      currentNode.trace.push(createTrace("node_run_retry_scheduled", { nodeRunId: nodeRun.id }, now));
      current.status = "pending";
      current.error = undefined;
      current.trace.push(createTrace("agent_run_retry_scheduled", { runId, nodeRunId: nodeRun.id }, now));
      return current;
    });
    return this.advanceGraphRun(projectId, runId);
  }

  async resumeNodeRun(projectId, runId, input = {}) {
    const payload = resumeNodeRunSchema.parse(input);
    const { run } = await this.getAgentRun(projectId, runId);
    const nodeRun = payload.nodeRunId
      ? run.nodeRuns?.[payload.nodeRunId]
      : Object.values(run.nodeRuns || {}).find((item) => item.nodeId === payload.nodeId);
    if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
    if (nodeRun.status !== "waiting") {
      throw new AgentOrchestratorError("Only waiting node runs can be resumed.", 400);
    }
    await this.updateAgentRun(projectId, runId, (current, now) => {
      const currentNode = current.nodeRuns[nodeRun.id];
      currentNode.status = "completed";
      currentNode.output = {
        kind: "wait",
        resumed: true,
        value: payload.output,
      };
      currentNode.updatedAt = now;
      currentNode.trace.push(createTrace("node_run_resumed", {
        nodeRunId: nodeRun.id,
        nodeId: currentNode.nodeId,
        output: payload.output,
      }, now));
      current.status = "running";
      current.trace.push(createTrace("agent_run_resumed", { runId, nodeRunId: nodeRun.id }, now));
      markReadyNodes(current, now);
      return current;
    });
    return this.advanceGraphRun(projectId, runId);
  }

  async createProject(input) {
    const payload = createProjectSchema.parse(input);
    const store = await this.readStore();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const projectDirectory = this.resourceManager
      ? await this.resourceManager.createProjectWorkspace({ projectId, projectName: payload.name })
      : {};
    const knowledgeTopicRefs = normalizeTopicRefs(payload.knowledgeTopicRefs, payload.knowledgeDrawerRefs);
    const knowledgeDrawerRefs = normalizeDomainRefs(payload.knowledgeDrawerRefs, knowledgeTopicRefs);
    const project = {
      id: projectId,
      name: payload.name,
      description: payload.description || "",
      agentIds: dedupe(payload.agentIds),
      knowledgeDrawerRefs,
      knowledgeTopicRefs,
      anythingllmWorkspaceSlug: "",
      localWorkspacePath: projectDirectory.workspacePath || "",
      localWorkspaceFolderName: projectDirectory.workspaceFolderName || "",
      metadata: payload.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    store.projects.push(project);
    await this.writeStore(store);
    return { project };
  }

  async updateProject(id, input) {
    const payload = updateProjectSchema.parse(input);
    const store = await this.readStore();
    const index = store.projects.findIndex((item) => item.id === id);
    if (index === -1) throw new AgentOrchestratorError(`Workspace ${id} was not found.`, 404);

    const current = store.projects[index];
    const nextTopicRefs = payload.knowledgeTopicRefs
      ? normalizeTopicRefs(payload.knowledgeTopicRefs, payload.knowledgeDrawerRefs || current.knowledgeDrawerRefs)
      : current.knowledgeTopicRefs || [];
    const nextDrawerRefs = payload.knowledgeDrawerRefs
      ? normalizeDomainRefs(payload.knowledgeDrawerRefs, nextTopicRefs)
      : normalizeDomainRefs(current.knowledgeDrawerRefs || [], nextTopicRefs);
    const updated = {
      ...current,
      ...definedOnly({
        name: payload.name,
        description: payload.description,
        agentIds: payload.agentIds ? dedupe(payload.agentIds) : undefined,
        knowledgeDrawerRefs: payload.knowledgeDrawerRefs || payload.knowledgeTopicRefs ? nextDrawerRefs : undefined,
        knowledgeTopicRefs: payload.knowledgeTopicRefs ? nextTopicRefs : undefined,
        metadata: payload.metadata,
      }),
      updatedAt: new Date().toISOString(),
    };

    store.projects[index] = updated;
    await this.writeStore(store);
    return { project: updated };
  }

  async deleteProject(id) {
    const store = await this.readStore();
    const next = store.projects.filter((item) => item.id !== id);
    if (next.length === store.projects.length) {
      throw new AgentOrchestratorError(`Workspace ${id} was not found.`, 404);
    }
    store.projects = next;
    const deletedConversations = store.conversations.filter((conversation) => conversation.projectId === id).length;
    const deletedRuns = store.agentRuns.filter((run) => run.workspaceId === id || run.projectId === id).length;
    store.conversations = store.conversations.filter((conversation) => conversation.projectId !== id);
    store.agentRuns = store.agentRuns.filter((run) => run.workspaceId !== id && run.projectId !== id);
    await this.writeStore(store);
    return { deleted: true, id, deletedConversations, deletedRuns };
  }

  async executeAgentTask(id, input) {
    const prepared = await this.prepareAgentTask(id, input);
    const { payload, project, agent, request, retrieval, rootSession } = prepared;
    if (agent?.type === "dag") {
      return this.executeDagAgentTask(prepared);
    }
    const agentRun = await this.createAgentRun(project, rootSession, agent, request, {
      input: { task: payload.task, context: payload.context || {} },
      retrieval,
    });

    if (payload.dryRun) {
      const completedRun = await this.completeAgentRun(project.id, agentRun.id, {
        status: "completed",
        output: { dryRun: true, request },
        nodeOutput: { dryRun: true, request },
      });
      return { project, agent, request, retrieval, dryRun: true, agentRun: completedRun.run };
    }

    const runtime = this.runtimeRegistry.getRuntime(request.runtimeId);
    await this.markAgentRunRunning(project.id, agentRun.id, request.runId);
    try {
      const result = await runtime.execute({
        project,
        agent,
        prompt: request.message,
        rootSession,
        reset: request.reset,
        runId: request.runId,
        contextPolicy: request.contextPolicy,
        runtimeOptions: request.runtimeOptions,
      });
      await this.persistRuntimeSession(project.id, payload.sessionId, result.runtimeSession, agent?.id, result.runId);
      const completedRun = await this.completeAgentRun(project.id, agentRun.id, {
        status: "completed",
        output: result,
        nodeOutput: result,
        runtimeSession: result.runtimeSession,
        trace: result.events || [],
      });

      return { project, agent, request, retrieval, result, agentRun: completedRun.run };
    } catch (error) {
      await this.completeAgentRun(project.id, agentRun.id, {
        status: error.status === 499 || error.details?.cancelled ? "cancelled" : "failed",
        error: serializeError(error),
      }).catch(() => {});
      throw error;
    }
  }

  async streamAgentTask(id, input, onEvent) {
    const prepared = await this.prepareAgentTask(id, input);
    const { payload, project, agent, request, retrieval, rootSession } = prepared;
    if (agent?.type === "dag") {
      return this.executeDagAgentTask(prepared, onEvent);
    }
    const agentRun = await this.createAgentRun(project, rootSession, agent, request, {
      input: { task: payload.task, context: payload.context || {} },
      retrieval,
    });

    onEvent?.({ type: "prepared", project, agent, request, retrieval, agentRun });

    if (payload.dryRun) {
      const result = { dryRun: true, text: `已生成编排请求：\n\n${request.message}` };
      const completedRun = await this.completeAgentRun(project.id, agentRun.id, {
        status: "completed",
        output: result,
        nodeOutput: result,
      });
      onEvent?.({ type: "done", project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { project, agent, request, retrieval, result, agentRun: completedRun.run };
    }

    const runtime = this.runtimeRegistry.getRuntime(request.runtimeId);
    await this.markAgentRunRunning(project.id, agentRun.id, request.runId);
    const tracedEvent = async (event) => {
      onEvent?.(event);
      if (event?.type === "runtime_event") {
        await this.appendAgentRunTrace(project.id, agentRun.id, {
          type: event.eventType || event.type,
          sourceType: event.sourceType,
          runId: event.runId,
          payload: event.payload,
        });
      }
    };
    try {
      const result = runtime.stream
        ? await runtime.stream({
            project,
            agent,
            prompt: request.message,
            rootSession,
            reset: request.reset,
            runId: request.runId,
            contextPolicy: request.contextPolicy,
            runtimeOptions: request.runtimeOptions,
            onEvent: tracedEvent,
          })
        : await runtime.execute({
            project,
            agent,
            prompt: request.message,
            rootSession,
            reset: request.reset,
            runId: request.runId,
            contextPolicy: request.contextPolicy,
            runtimeOptions: request.runtimeOptions,
          });

      await this.persistRuntimeSession(project.id, payload.sessionId, result.runtimeSession, agent?.id, result.runId);
      const completedRun = await this.completeAgentRun(project.id, agentRun.id, {
        status: "completed",
        output: result,
        nodeOutput: result,
        runtimeSession: result.runtimeSession,
        trace: result.events || [],
      });
      onEvent?.({ type: "done", project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { project, agent, request, retrieval, result, agentRun: completedRun.run };
    } catch (error) {
      await this.completeAgentRun(project.id, agentRun.id, {
        status: error.status === 499 || error.details?.cancelled ? "cancelled" : "failed",
        error: serializeError(error),
      }).catch(() => {});
      throw error;
    }
  }

  async executeDagAgentTask(prepared, onEvent) {
    const { payload, project, agent, request, retrieval, rootSession } = prepared;
    const agentRun = await this.createAgentRun(project, rootSession, agent, request, {
      input: { task: payload.task, context: payload.context || {} },
      retrieval,
    });
    onEvent?.({ type: "prepared", project, agent, request, retrieval, agentRun });

    if (payload.dryRun) {
      const completedRun = await this.completeDagDryRun(project.id, agentRun.id, request);
      const result = {
        dryRun: true,
        text: `已生成 DAG 运行图：${Object.keys(completedRun.run.nodeRuns || {}).length} 个节点。`,
      };
      onEvent?.({ type: "done", project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { project, agent, request, retrieval, result, dryRun: true, agentRun: completedRun.run };
    }

    try {
      const completedRun = await this.runDagToCompletion(project, agent, request, agentRun.id, onEvent);
      const result = {
        runtimeId: request.runtimeId,
        runId: agentRun.id,
        text: stringifyDagOutput(completedRun.run.output),
        output: completedRun.run.output,
      };
      onEvent?.({ type: "done", project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { project, agent, request, retrieval, result, agentRun: completedRun.run };
    } catch (error) {
      const status = error.status === 499 || error.details?.cancelled ? "cancelled" : "failed";
      await this.completeDagRun(project.id, agentRun.id, {
        status,
        error: serializeError(error),
      }).catch(() => {});
      throw error;
    }
  }

  async prepareAgentTask(id, input) {
    const payload = executeAgentTaskSchema.parse(input);
    const { project } = await this.getProject(id);
    const rootSession = payload.sessionId
      ? await this.ensureExecutionConversation(id, payload.sessionId, payload)
      : undefined;
    const agent = payload.agentId ? (await this.getAgent(payload.agentId)).agent : undefined;
    if (agent && !project.agentIds?.includes(agent.id)) {
      throw new AgentOrchestratorError(
        `Agent ${agent.id} is not enabled for workspace ${project.id}.`,
        403
      );
    }

    const searchTopicRefs = dedupe([
      ...(payload.knowledgeTopicRefs || []),
      ...(payload.knowledgeTags || []).map((tag) => resolveTopicTag(project, tag)).filter(Boolean),
    ]);
    const mode = payload.mode || agent?.defaultMode || "chat";
    const knowledgeScope = resolveWorkspaceKnowledgeScope(project, { topicRefs: searchTopicRefs });
    const knowledgeIndex = this.resourceManager
      ? await this.resourceManager.getProjectKnowledgeIndex(knowledgeScope)
      : { domains: [], topics: [] };
    const retrieval = await this.searchProjectKnowledge(project, {
      query: payload.task,
      topN: agent?.topN || 4,
      scoreThreshold: agent?.scoreThreshold,
      topicRefs: searchTopicRefs,
      knowledgeIndex,
    });
    const contextPolicy = buildContextPolicy(payload, rootSession);
    const runtimeOptions = buildRuntimeOptions(payload);
    const message = buildAgentMessage(project, agent, payload.task, payload.context, {
      runtimeId: agent?.runtimeId || this.settings.defaultRuntimeId || config.defaultRuntimeId,
      knowledgeIndex,
      retrieval,
      knowledgeTags: payload.knowledgeTags,
      contextPolicy,
      runtimeOptions,
    });
    const request = {
      runtimeId: agent?.runtimeId || this.settings.defaultRuntimeId || config.defaultRuntimeId,
      runId: payload.runId || randomUUID(),
      projectId: project.id,
      workspaceSlug: "",
      mode,
      message,
      sessionId: payload.sessionId,
      reset: payload.reset || contextPolicy.strategy === "reset" || contextPolicy.strategy === "manual-summary",
      contextPolicy,
      runtimeOptions,
    };
    return { payload, project, agent, request, retrieval, rootSession };
  }

  async ensureExecutionConversation(projectId, sessionId, payload = {}) {
    try {
      return (await this.getConversation(projectId, sessionId)).conversation;
    } catch (error) {
      if (error.status !== 404) throw error;
      return (await this.createConversation(projectId, {
        id: sessionId,
        title: deriveConversationTitle([{ role: "user", text: payload.task || "" }]) || "新对话",
        metadata: {
          createdBy: "execute",
          activeAgentId: payload.agentId || "",
        },
      })).conversation;
    }
  }

  cancelRuntimeRun(runId) {
    return this.runtimeRegistry.cancelRun(runId);
  }

  async cancelAgentRun(projectId, runId) {
    const store = await this.readStore();
    const index = store.agentRuns.findIndex((item) => item.workspaceId === projectId && item.id === runId);
    if (index === -1) return this.cancelRuntimeRun(runId);
    const now = new Date().toISOString();
    const run = normalizeAgentRun(store.agentRuns[index]);
    const cancellations = [];
    for (const nodeRun of Object.values(run.nodeRuns || {})) {
      if (nodeRun.status === "running" && nodeRun.runtimeRunId) {
        cancellations.push(this.cancelRuntimeRun(nodeRun.runtimeRunId));
      }
      if (["pending", "ready", "running", "waiting"].includes(nodeRun.status)) {
        nodeRun.status = "cancelled";
        nodeRun.updatedAt = now;
        nodeRun.trace.push(createTrace("node_run_cancelled", { nodeRunId: nodeRun.id }, now));
      }
    }
    cancellations.push(this.cancelRuntimeRun(runId));
    run.status = "cancelled";
    run.error = { message: "Agent run was cancelled." };
    run.updatedAt = now;
    run.trace.push(createTrace("agent_run_cancelled", { runId, cancellations }, now));
    store.agentRuns[index] = run;
    await this.writeStore(store);
    return { cancelled: true, run, cancellations };
  }

  async createAgentRun(project, rootSession, agent, request, { input, retrieval } = {}) {
    const store = await this.readStore();
    this.findProject(store, project.id);
    const now = new Date().toISOString();
    const agentSnapshot = snapshotAgentDefinition(agent);
    const nodeRuns = createNodeRuns({
      runId: request.runId,
      request,
      agentSnapshot,
      input,
      now,
    });
    const run = {
      id: request.runId,
      rootSessionId: rootSession?.id || request.sessionId || "",
      workspaceId: project.id,
      agentId: agent?.id || "",
      agentVersion: agentSnapshot.version,
      agentSnapshot,
      status: "pending",
      input,
      output: undefined,
      error: undefined,
      request,
      nodeRuns,
      trace: [{
        id: randomUUID(),
        type: "agent_run_created",
        createdAt: now,
        payload: { runId: request.runId, runtimeId: request.runtimeId, retrieval },
      }],
      createdAt: now,
      updatedAt: now,
    };
    store.agentRuns.push(run);
    if (rootSession?.id) {
      const conversationIndex = store.conversations.findIndex((item) =>
        item.projectId === project.id && item.id === rootSession.id
      );
      if (conversationIndex !== -1) {
        store.conversations[conversationIndex] = normalizeConversation({
          ...store.conversations[conversationIndex],
          runIds: dedupe([...(store.conversations[conversationIndex].runIds || []), run.id]),
          updatedAt: now,
        });
      }
    }
    await this.writeStore(store);
    return run;
  }

  async markAgentRunRunning(projectId, runId, runtimeRunId) {
    return this.updateAgentRun(projectId, runId, (run, now) => {
      const nodeRun = getPrimaryNodeRun(run);
      nodeRun.status = "running";
      nodeRun.runtimeRunId = runtimeRunId;
      nodeRun.updatedAt = now;
      run.status = "running";
      run.trace.push(createTrace("agent_run_started", { runId, runtimeRunId }, now));
      return run;
    });
  }

  async appendAgentRunTrace(projectId, runId, event) {
    return this.updateAgentRun(projectId, runId, (run, now) => {
      const trace = createTrace(event.type || "runtime_event", event, now);
      run.trace.push(trace);
      const nodeRun = getPrimaryNodeRun(run);
      nodeRun.trace.push(trace);
      nodeRun.updatedAt = now;
      return run;
    });
  }

  async completeAgentRun(projectId, runId, { status, output, nodeOutput, runtimeSession, trace = [], error } = {}) {
    return this.updateAgentRun(projectId, runId, (run, now) => {
      const nodeRun = getPrimaryNodeRun(run);
      run.status = status;
      run.output = output;
      run.error = error;
      run.updatedAt = now;
      nodeRun.status = status === "completed" ? "completed" : status;
      nodeRun.output = nodeOutput;
      nodeRun.error = error;
      nodeRun.runtimeSession = runtimeSession || nodeRun.runtimeSession;
      nodeRun.updatedAt = now;
      for (const event of trace) {
        const traceEvent = createTrace(event.type || "runtime_event", event, now);
        run.trace.push(traceEvent);
        nodeRun.trace.push(traceEvent);
      }
      run.trace.push(createTrace(`agent_run_${status}`, { runId, status, error }, now));
      return run;
    });
  }

  async updateAgentRun(projectId, runId, updater) {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      this.findProject(store, projectId);
      const index = store.agentRuns.findIndex((item) => item.workspaceId === projectId && item.id === runId);
      if (index === -1) throw new AgentOrchestratorError(`Agent run ${runId} was not found.`, 404);
      const now = new Date().toISOString();
      const updated = normalizeAgentRun(updater(deepClone(store.agentRuns[index]), now));
      updated.updatedAt = now;
      store.agentRuns[index] = updated;
      await this.writeStore(store);
      return { run: updated };
    });
  }

  async completeDagDryRun(projectId, runId, request) {
    return this.updateAgentRun(projectId, runId, (run, now) => {
      run.status = "completed";
      run.output = {
        dryRun: true,
        request,
        nodeOrder: topologicalNodeIds(run.agentSnapshot),
      };
      for (const nodeRun of Object.values(run.nodeRuns || {})) {
        nodeRun.status = "completed";
        nodeRun.output = { dryRun: true, nodeId: nodeRun.nodeId, request };
        nodeRun.updatedAt = now;
        nodeRun.trace.push(createTrace("node_run_dry_completed", { nodeId: nodeRun.nodeId }, now));
      }
      run.trace.push(createTrace("agent_run_dry_completed", { runId }, now));
      return run;
    });
  }

  async runDagToCompletion(project, agent, request, runId, onEvent) {
    await this.updateAgentRun(project.id, runId, (run, now) => {
      run.status = "running";
      markReadyNodes(run, now);
      run.trace.push(createTrace("dag_run_started", { runId }, now));
      return run;
    });

    while (true) {
      const { run } = await this.getAgentRun(project.id, runId);
      if (hasFailedRequiredNode(run)) {
        return this.completeDagRun(project.id, runId, {
          status: "failed",
          error: { message: "DAG run failed because a required node failed." },
        });
      }
      const ready = readyNodeRuns(run);
      if (!ready.length) {
        if (allNodesCompleted(run)) {
          return this.completeDagRun(project.id, runId, {
            status: "completed",
            output: collectDagOutput(run),
          });
        }
        return this.updateAgentRun(project.id, runId, (current, now) => {
          current.status = "waiting";
          current.trace.push(createTrace("dag_run_waiting", { runId }, now));
          return current;
        });
      }

      const batch = ready.slice(0, dagConcurrency(run.agentSnapshot));
      await Promise.all(batch.map((nodeRun) =>
        this.executeDagNode(project, agent, request, runId, nodeRun.id, onEvent)
      ));
      await this.updateAgentRun(project.id, runId, (current, now) => {
        markReadyNodes(current, now);
        return current;
      });
    }
  }

  async executeDagNode(project, agent, request, runId, nodeRunId, onEvent) {
    const { run, nodeRun } = await this.getNodeRun(project.id, runId, nodeRunId);
    const nodeDef = run.agentSnapshot.nodes.find((node) => node.id === nodeRun.nodeId);
    if (!nodeDef) throw new AgentOrchestratorError(`DAG node ${nodeRun.nodeId} was not found in snapshot.`, 500);
    if (nodeDef.kind === "wait") {
      const nodeInput = buildNodeInput(run, nodeRun, request);
      const updated = await this.updateAgentRun(project.id, runId, (current, now) => {
        const currentNode = current.nodeRuns[nodeRunId];
        current.status = "waiting";
        currentNode.status = "waiting";
        currentNode.input = nodeInput;
        currentNode.updatedAt = now;
        const trace = createTrace("node_run_waiting", {
          nodeRunId,
          nodeId: currentNode.nodeId,
          prompt: nodeDef.description || nodeDef.name || currentNode.nodeId,
        }, now);
        current.trace.push(trace);
        currentNode.trace.push(trace);
        return current;
      });
      onEvent?.({ type: "dag_node_waiting", runId, nodeRunId, nodeId: nodeRun.nodeId, prompt: nodeDef.description || nodeDef.name || nodeRun.nodeId });
      return updated;
    }
    const nodeRuntimeId = nodeDef.runtimeId || run.agentSnapshot.runtimeId || request.runtimeId;
    const runtime = this.runtimeRegistry.getRuntime(nodeRuntimeId);
    const runtimeRunId = `${nodeRun.id}:${randomUUID()}`;
    const nodeAgent = buildNodeAgent(run.agentSnapshot, nodeDef, agent);
    const nodeInput = buildNodeInput(run, nodeRun, request);
    const prompt = buildDagNodePrompt(project, run, nodeDef, nodeInput);

    await this.updateAgentRun(project.id, runId, (current, now) => {
      const currentNode = current.nodeRuns[nodeRunId];
      current.status = "running";
      currentNode.status = "running";
      currentNode.runtimeRunId = runtimeRunId;
      currentNode.input = nodeInput;
      currentNode.updatedAt = now;
      const trace = createTrace("node_run_started", { nodeRunId, nodeId: currentNode.nodeId, runtimeRunId }, now);
      current.trace.push(trace);
      currentNode.trace.push(trace);
      return current;
    });
    onEvent?.({ type: "dag_node_started", runId, nodeRunId, nodeId: nodeRun.nodeId, runtimeRunId });

    try {
      const result = await runtime.execute({
        project,
        agent: nodeAgent,
        prompt,
        rootSession: undefined,
        reset: true,
        runId: runtimeRunId,
        contextPolicy: {
          strategy: "reset",
          summary: `DAG node ${nodeRun.nodeId} runs in an isolated runtime session under root run ${runId}.`,
        },
        runtimeOptions: request.runtimeOptions,
      });
      const updated = await this.updateAgentRun(project.id, runId, (current, now) => {
        const currentNode = current.nodeRuns[nodeRunId];
        currentNode.status = "completed";
        currentNode.output = result;
        currentNode.runtimeSession = result.runtimeSession;
        currentNode.updatedAt = now;
        const trace = createTrace("node_run_completed", {
          nodeRunId,
          nodeId: currentNode.nodeId,
          runtimeRunId,
          runtimeSession: result.runtimeSession,
        }, now);
        current.trace.push(trace);
        currentNode.trace.push(trace);
        for (const event of result.events || []) {
          const eventTrace = createTrace(event.type || "runtime_event", event, now);
          current.trace.push(eventTrace);
          currentNode.trace.push(eventTrace);
        }
        return current;
      });
      onEvent?.({ type: "dag_node_completed", runId, nodeRunId, nodeId: nodeRun.nodeId, result });
      return updated;
    } catch (error) {
      const status = error.status === 499 || error.details?.cancelled ? "cancelled" : "failed";
      await this.updateAgentRun(project.id, runId, (current, now) => {
        const currentNode = current.nodeRuns[nodeRunId];
        currentNode.status = status;
        currentNode.error = serializeError(error);
        currentNode.updatedAt = now;
        current.trace.push(createTrace(`node_run_${status}`, {
          nodeRunId,
          nodeId: currentNode.nodeId,
          error: currentNode.error,
        }, now));
        return current;
      });
      onEvent?.({ type: status, runId, nodeRunId, nodeId: nodeRun.nodeId, error: error.message });
      throw error;
    }
  }

  async completeDagRun(projectId, runId, { status, output, error } = {}) {
    return this.updateAgentRun(projectId, runId, (run, now) => {
      run.status = status;
      run.output = output || run.output;
      run.error = error;
      run.trace.push(createTrace(`dag_run_${status}`, { runId, status, error }, now));
      return run;
    });
  }

  async persistRuntimeSession(projectId, conversationId, runtimeSession, agentId = "", runId = "") {
    if (!conversationId || !runtimeSession?.provider) return;
    const store = await this.readStore();
    this.findProject(store, projectId);
    const index = store.conversations.findIndex((item) =>
      item.projectId === projectId && item.id === conversationId
    );
    if (index === -1) return;
    const current = store.conversations[index];
    const now = new Date().toISOString();
    const runtimeSessions = {
      ...normalizeRuntimeSessions(current.runtimeSessions || current.metadata?.runtimeSessions),
      [runtimeSession.provider]: {
        ...(current.runtimeSessions?.[runtimeSession.provider] || {}),
        ...runtimeSession,
        updatedAt: runtimeSession.updatedAt || now,
        createdAt: current.runtimeSessions?.[runtimeSession.provider]?.createdAt || now,
      },
    };
    const metadata = {
      ...(current.metadata || {}),
      runtimeSessions,
      lastRuntimeProvider: runtimeSession.provider,
      lastRuntimeSessionId: runtimeSession.sessionId || "",
      lastRunId: runId || current.metadata?.lastRunId || "",
    };
    store.conversations[index] = normalizeConversation({
      ...current,
      activeAgentId: agentId || current.activeAgentId || "",
      runtimeSessions,
      runIds: dedupe([...(current.runIds || []), runId]),
      metadata,
      updatedAt: now,
    });
    await this.writeStore(store);
  }

  async retrieveRag(payload) {
    if (this.ragProvider.retrieve) return this.ragProvider.retrieve(payload);
    return this.client.vectorSearch(payload.workspaceSlug, payload);
  }

  async getProjectKnowledgeIndex(projectId) {
    const { project } = await this.getProject(projectId);
    return this.getProjectKnowledgePlan(project, {});
  }

  async getProjectKnowledgePlan(projectOrId, input = {}) {
    const project = typeof projectOrId === "string" ? (await this.getProject(projectOrId)).project : projectOrId;
    const scope = resolveWorkspaceKnowledgeScope(project, input);
    const knowledge = this.resourceManager
      ? scope.empty
        ? { domains: [], topics: [] }
        : await this.resourceManager.getProjectKnowledgeIndex(scope)
      : { domains: [], topics: [] };
    return {
      project,
      scope,
      knowledge,
      protocol: {
        authorization:
          "一级知识库是工作区授权边界；二级主题是该边界内的检索筛选。请求范围只能是工作区授权范围的子集。",
        selection:
          "先读取 domains/topics 的名称、描述、文档数量和 RAG workspace 状态，再选择 topicRefs 调用 rag-search。",
        retrieval:
          "每个二级主题映射到一个 RAG provider workspace；Hippo 会按选定主题 fan-out 检索并合并结果。",
      },
    };
  }

  async searchProjectKnowledge(projectOrId, input = {}) {
    const project = typeof projectOrId === "string" ? (await this.getProject(projectOrId)).project : projectOrId;
    const scope = resolveWorkspaceKnowledgeScope(project, input);
    const knowledgeIndex = input.knowledgeIndex || (this.resourceManager
      ? scope.empty
        ? { domains: [], topics: [] }
        : await this.resourceManager.getProjectKnowledgeIndex({
          drawerRefs: scope.drawerRefs,
          topicRefs: scope.topicRefs,
        })
      : { domains: [], topics: [] });
    if (!input.query) return { skipped: true, reason: "missing-query", results: [], topics: knowledgeIndex.topics };
    if (!knowledgeIndex.topics.length) {
      return { skipped: true, reason: "workspace-has-no-authorized-topics", results: [], topics: [] };
    }

    const searches = [];
    for (const topic of knowledgeIndex.topics) {
      const sync = this.resourceManager
        ? await this.resourceManager.syncTopicWorkspace(topic.path)
        : { workspaceSlug: topic.rag?.workspaceSlug, documentNames: [] };
      if (!sync.workspaceSlug) continue;
      const result = await this.retrieveRag({
        workspaceSlug: sync.workspaceSlug,
        query: input.query,
        topN: input.topN || 4,
        scoreThreshold: input.scoreThreshold,
      });
      searches.push({ topic, workspaceSlug: sync.workspaceSlug, documentNames: sync.documentNames, result });
    }

    const results = mergeRagResults(searches);
    return {
      skipped: false,
      query: input.query,
      scope,
      topics: knowledgeIndex.topics,
      searches,
      results,
    };
  }

  async resolveAnythingllmWorkspace(payload) {
    const response = this.ragProvider.ensureWorkspace
      ? await this.ragProvider.ensureWorkspace({ name: payload.name })
      : await this.client.createWorkspace({ name: payload.name, chatMode: "chat" });
    const slug = extractWorkspaceSlug(response);
    if (!slug) {
      throw new AgentOrchestratorError("AnythingLLM workspace was created but no slug was returned.", 502, response);
    }
    return slug;
  }

  async readStore() {
    try {
      const content = await fs.readFile(this.storePath, "utf8");
      const store = JSON.parse(content);
      return {
        version: 3,
        projects: normalizeProjects(store.projects || store.agentWorkspaces),
        agents: normalizeAgents(store.agents),
        conversations: normalizeConversations(store.conversations),
        agentRuns: normalizeAgentRuns(store.agentRuns),
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 3, projects: [], agents: [], conversations: [], agentRuns: [] };
      throw error;
    }
  }

  async writeStore(store) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
  }

  async withStoreLock(operation) {
    const previous = this.storeLock;
    let release;
    this.storeLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  findProject(store, projectId) {
    const project = store.projects.find((item) => item.id === projectId);
    if (!project) throw new AgentOrchestratorError(`Workspace ${projectId} was not found.`, 404);
    return project;
  }
}

export class AgentOrchestratorError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.name = "AgentOrchestratorError";
    this.status = status;
    this.details = details;
  }
}

export function buildAgentMessage(project, agent, task, context = undefined, options = {}) {
  const sections = [
    `你正在 Hippo 工作区「${project.name}」中执行任务。`,
    project.description ? `工作区说明：\n${project.description}` : "",
    `当前 runtime：${options.runtimeId || agent?.runtimeId || config.defaultRuntimeId}`,
    agent ? `本次加载的全局 Agent：${agent.name}` : "本次未加载 Agent，使用通用助手执行。",
    agent?.description ? `Agent 说明：\n${agent.description}` : "",
    agent?.systemPrompt ? `Agent 系统指令：\n${agent.systemPrompt}` : "",
    agent?.skills?.length
      ? `Agent 可使用技能：\n${agent.skills.map(formatSkill).join("\n")}`
      : agent ? "Agent 可使用技能：未显式配置。" : "",
    agent?.mcpServers?.length
      ? `Agent 可访问 MCP：\n${agent.mcpServers.map((name) => `- ${name}`).join("\n")}`
      : agent ? "Agent 可访问 MCP：未显式配置。" : "",
    agent
      ? `RAG 授权边界：只能使用当前工作区引用的一级知识库和已筛选主题。AnythingLLM 仅作为检索 provider，不作为对话 runtime。`
      : "当前未加载 Agent；仍需遵守工作区的知识库引用边界。",
    project.knowledgeDrawerRefs?.length
      ? `工作区可访问的一级知识库：\n${project.knowledgeDrawerRefs.map((name) => `- ${name}`).join("\n")}`
      : "工作区未引用任何一级知识库。",
    options.knowledgeTags?.length
      ? `本次二级 tag 过滤：\n${options.knowledgeTags.map((name) => `- ${name}`).join("\n")}`
      : "",
    options.knowledgeIndex?.topics?.length
      ? `本次可检索主题索引：\n${options.knowledgeIndex.topics.map(formatKnowledgeTopic).join("\n")}`
      : "本次没有可检索主题。",
    options.retrieval ? `RAG 检索结果：\n${JSON.stringify(options.retrieval, null, 2)}` : "",
    options.contextPolicy?.strategy
      ? `会话上下文策略：${formatContextPolicy(options.contextPolicy)}`
      : "",
    options.runtimeOptions?.sandboxMode ? `本轮 Codex sandbox 权限：${options.runtimeOptions.sandboxMode}` : "",
    project.localWorkspacePath ? `本地工作区目录：\n${project.localWorkspacePath}` : "",
    context ? `运行时上下文：\n${JSON.stringify(context, null, 2)}` : "",
    `任务：\n${task}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function agentSchemas() {
  return {
    createProjectSchema,
    updateProjectSchema,
    createConversationSchema,
    updateConversationSchema,
    createAgentSchema,
    updateAgentSchema,
    executeAgentTaskSchema,
    agentNodeSchema,
    agentEdgeSchema,
  };
}

function deriveConversationTitle(messages = []) {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.text?.trim());
  if (!firstUserMessage) return "";
  const compact = firstUserMessage.text.trim().replace(/\s+/g, " ");
  return compact.length > 28 ? `${compact.slice(0, 28)}...` : compact;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => ({
    role: ["user", "assistant", "system"].includes(message.role) ? message.role : "assistant",
    text: String(message.text || ""),
    runId: message.runId || "",
    agentRunSummary: message.agentRunSummary && typeof message.agentRunSummary === "object" && !Array.isArray(message.agentRunSummary)
      ? message.agentRunSummary
      : undefined,
    metadata: message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? message.metadata
      : undefined,
    createdAt: message.createdAt || new Date().toISOString(),
  }));
}

function extractWorkspaceSlug(response) {
  return response?.workspace?.slug || response?.slug || response?.workspace?.[0]?.slug;
}

function formatSkill(skill) {
  const details = [skill.description, skill.instructions].filter(Boolean).join(" ");
  return details ? `- ${skill.name}: ${details}` : `- ${skill.name}`;
}

function formatKnowledgeTopic(topic) {
  const description = topic.description ? `：${topic.description}` : "";
  const docs = Number.isFinite(topic.documentCount) ? `，${topic.documentCount} 个文档` : "";
  return `- ${topic.domainName || topic.domainPath || ""}/${topic.name || topic.path}${description}${docs}`;
}

function formatContextPolicy(policy) {
  if (policy.strategy === "reset") return "重置 runtime 会话，不继承之前的 Codex session。";
  if (policy.strategy === "manual-summary") {
    return [
      "使用人工摘要作为新上下文，不直接继承之前的 Codex session。",
      policy.summary ? `摘要：\n${policy.summary}` : "未提供摘要。",
    ].join("\n");
  }
  return policy.previousRuntimeSessionId
    ? `继承 runtime session：${policy.previousRuntimeSessionId}`
    : "使用 runtime 默认上下文；当前没有可继承的 session。";
}

function buildContextPolicy(payload, rootSession) {
  const strategy = ["runtime", "reset", "manual-summary"].includes(payload.contextStrategy)
    ? payload.contextStrategy
    : payload.reset
      ? "reset"
      : "runtime";
  const previousRuntimeSession = rootSession?.runtimeSessions?.codex;
  return {
    strategy,
    summary: payload.contextSummary ? String(payload.contextSummary).trim() : "",
    summaryUpdatedAt: payload.contextSummary ? new Date().toISOString() : "",
    rootSessionId: rootSession?.id || payload.sessionId || "",
    runtimeProvider: "codex",
    previousRuntimeSessionId: strategy === "runtime" ? previousRuntimeSession?.sessionId || "" : "",
  };
}

function buildRuntimeOptions(payload) {
  return stripEmptyObject({
    sandboxMode: ["workspace-write", "read-only", "danger-full-access"].includes(payload.sandboxMode)
      ? payload.sandboxMode
      : "",
  });
}

function stripEmptyObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function definedOnly(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function primaryDrawer(value) {
  return String(value || "").replaceAll("\\", "/").split("/").filter(Boolean)[0] || "";
}

function normalizeTopicRefs(topicRefs = [], drawerRefs = []) {
  const domains = new Set((drawerRefs || []).map(primaryDrawer).filter(Boolean));
  return dedupe((topicRefs || []).map(topicPath).filter((value) => {
    if (!value) return false;
    return !domains.size || domains.has(primaryDrawer(value));
  }));
}

function normalizeDomainRefs(drawerRefs = [], topicRefs = []) {
  return dedupe([
    ...(drawerRefs || []).map(primaryDrawer),
    ...(topicRefs || []).map(primaryDrawer),
  ]);
}

function resolveWorkspaceKnowledgeScope(project, input = {}) {
  const workspaceDomains = normalizeDomainRefs(project.knowledgeDrawerRefs || [], project.knowledgeTopicRefs || []);
  const requestedDomains = normalizeDomainRefs(input.drawerRefs || input.domainRefs || [], input.topicRefs || []);
  const hasRequestedDomains = Boolean((input.drawerRefs || input.domainRefs || []).length);
  const hasRequestedTopics = Boolean((input.topicRefs || input.knowledgeTopicRefs || []).length);
  const drawerRefs = requestedDomains.length
    ? workspaceDomains.filter((domain) => requestedDomains.includes(domain))
    : workspaceDomains;
  const workspaceTopics = normalizeTopicRefs(project.knowledgeTopicRefs || [], drawerRefs);
  const requestedTopics = normalizeTopicRefs(input.topicRefs || input.knowledgeTopicRefs || [], drawerRefs);
  const topicRefs = requestedTopics.length
    ? requestedTopics.filter((topic) => !workspaceTopics.length || workspaceTopics.includes(topic))
    : workspaceTopics;
  const empty = !drawerRefs.length || (hasRequestedTopics && !topicRefs.length) || (hasRequestedDomains && !requestedDomains.length);
  return { drawerRefs, topicRefs, empty };
}

function topicPath(value) {
  const parts = String(value || "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
}

function resolveTopicTag(project, tag) {
  const text = String(tag || "").replaceAll("\\", "/").trim();
  if (!text) return "";
  if (text.includes("/")) return topicPath(text);
  const domains = project.knowledgeDrawerRefs || [];
  return domains.length === 1 ? `${domains[0]}/${text}` : "";
}

function mergeRagResults(searches = []) {
  const rows = [];
  for (const search of searches) {
    const rawResults = Array.isArray(search.result?.results)
      ? search.result.results
      : Array.isArray(search.result?.sources)
        ? search.result.sources
        : [];
    for (const item of rawResults) {
      const score = Number(item.score ?? item.metadata?.score ?? 0);
      rows.push({
        ...item,
        score,
        topicPath: search.topic.path,
        topicName: search.topic.name,
        domainPath: search.topic.domainPath,
        domainName: search.topic.domainName,
      });
    }
  }
  return rows
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 12);
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) return [];
  return projects.map((project) => {
    const knowledgeTopicRefs = Array.isArray(project.knowledgeTopicRefs)
      ? normalizeTopicRefs(project.knowledgeTopicRefs, project.knowledgeDrawerRefs)
      : [];
    return {
      ...project,
      agentIds: Array.isArray(project.agentIds) ? project.agentIds : [],
      knowledgeDrawerRefs: normalizeDomainRefs(
        Array.isArray(project.knowledgeDrawerRefs) ? project.knowledgeDrawerRefs : [],
        knowledgeTopicRefs
      ),
      knowledgeTopicRefs,
    };
  });
}

function normalizeAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.map(normalizeAgent);
}

function normalizeAgent(agent) {
  const { knowledgeRefs, ...current } = agent || {};
  const type = current.type === "dag" ? "dag" : "single";
  const nodes = type === "dag" ? normalizeAgentNodes(current.nodes) : [];
  return {
    ...current,
    type,
    version: Number(current.version || 1),
    mcpServers: Array.isArray(current.mcpServers) ? current.mcpServers : [],
    runtimeId: current.runtimeId || config.defaultRuntimeId,
    explicitRagDocumentNames: current.explicitRagDocumentNames || current.ragDocumentNames || [],
    ragDocumentNames: current.ragDocumentNames || current.explicitRagDocumentNames || [],
    rag: current.rag && typeof current.rag === "object" && !Array.isArray(current.rag) ? current.rag : {},
    rootNodeId: type === "dag" ? current.rootNodeId || nodes[0]?.id || "" : "",
    nodes,
    edges: type === "dag" ? normalizeAgentEdges(current.edges) : [],
    executionPolicy: current.executionPolicy && typeof current.executionPolicy === "object" && !Array.isArray(current.executionPolicy)
      ? current.executionPolicy
      : {},
    metadata: current.metadata || {},
  };
}

function normalizeAgentNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => ({
    id: String(node.id || "").trim(),
    kind: node.kind === "wait" ? "wait" : "task",
    name: node.name || node.id || "",
    description: node.description || "",
    agentId: node.agentId || "",
    systemPrompt: node.systemPrompt || "",
    runtimeId: node.runtimeId || "",
    skills: Array.isArray(node.skills) ? node.skills : [],
    mcpServers: Array.isArray(node.mcpServers) ? node.mcpServers : [],
    input: node.input,
    metadata: node.metadata || {},
  })).filter((node) => node.id);
}

function normalizeAgentEdges(edges) {
  if (!Array.isArray(edges)) return [];
  return edges.map((edge) => ({
    id: edge.id || `${edge.from}->${edge.to}`,
    from: String(edge.from || "").trim(),
    to: String(edge.to || "").trim(),
    type: edge.type === "parallel" ? "parallel" : "serial",
    required: edge.required !== false,
    metadata: edge.metadata || {},
  })).filter((edge) => edge.from && edge.to);
}

function validateAgentPrototype(agent) {
  const normalized = normalizeAgent(agent);
  if (normalized.type !== "dag") return normalized;
  if (!normalized.nodes.length) {
    throw new AgentOrchestratorError("DAG agent requires at least one node.", 400);
  }
  const nodeIds = new Set();
  for (const node of normalized.nodes) {
    if (nodeIds.has(node.id)) {
      throw new AgentOrchestratorError(`DAG agent has duplicate node id: ${node.id}.`, 400);
    }
    nodeIds.add(node.id);
  }
  if (!normalized.rootNodeId || !nodeIds.has(normalized.rootNodeId)) {
    throw new AgentOrchestratorError("DAG agent rootNodeId must reference an existing node.", 400);
  }
  for (const edge of normalized.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new AgentOrchestratorError(`DAG edge ${edge.id} references an unknown node.`, 400);
    }
    if (edge.from === edge.to) {
      throw new AgentOrchestratorError(`DAG edge ${edge.id} cannot point to the same node.`, 400);
    }
  }
  assertAcyclic(normalized.nodes, normalized.edges);
  return normalized;
}

function assertAcyclic(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw new AgentOrchestratorError(`DAG contains a cycle at node ${nodeId}.`, 400);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) || []) visit(next);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}

function snapshotAgentDefinition(agent) {
  const normalized = normalizeAgent(agent || {
    id: "",
    name: "通用助手",
    type: "single",
    runtimeId: config.defaultRuntimeId,
  });
  return JSON.parse(JSON.stringify({
    id: normalized.id || "",
    version: normalized.version || 1,
    type: normalized.type,
    name: normalized.name || "通用助手",
    description: normalized.description || "",
    systemPrompt: normalized.systemPrompt || "",
    skills: normalized.skills || [],
    mcpServers: normalized.mcpServers || [],
    runtimeId: normalized.runtimeId || config.defaultRuntimeId,
    rag: normalized.rag || {},
    defaultMode: normalized.defaultMode || "chat",
    topN: normalized.topN || 4,
    scoreThreshold: normalized.scoreThreshold,
    rootNodeId: normalized.rootNodeId || "",
    nodes: normalized.nodes || [],
    edges: normalized.edges || [],
    executionPolicy: normalized.executionPolicy || {},
    metadata: normalized.metadata || {},
  }));
}

function createNodeRuns({ runId, request, agentSnapshot, input, now }) {
  if (agentSnapshot.type !== "dag") {
    const nodeRun = createNodeRun({
      runId,
      request,
      agentSnapshot,
      nodeId: "root",
      input,
      upstreamNodeIds: [],
      downstreamNodeIds: [],
      now,
    });
    return { [nodeRun.id]: nodeRun };
  }
  const nodeRuns = {};
  for (const node of agentSnapshot.nodes || []) {
    const upstream = upstreamNodeIds(node.id, agentSnapshot.edges);
    const nodeRun = createNodeRun({
      runId,
      request,
      agentSnapshot,
      nodeId: node.id,
      kind: node.kind || "task",
      input: node.id === agentSnapshot.rootNodeId ? input : undefined,
      upstreamNodeIds: upstream,
      downstreamNodeIds: downstreamNodeIds(node.id, agentSnapshot.edges),
      now,
    });
    nodeRun.status = upstream.length ? "pending" : "ready";
    nodeRuns[nodeRun.id] = nodeRun;
  }
  return nodeRuns;
}

function createNodeRun({ runId, request, agentSnapshot, nodeId, kind = "task", input, upstreamNodeIds, downstreamNodeIds, now }) {
  return {
    id: `${runId}:${nodeId || "root"}`,
    type: "node",
    runId,
    nodeId: nodeId || "root",
    kind,
    agentId: agentSnapshot.id || "",
    status: upstreamNodeIds.length ? "pending" : "ready",
    runtimeRunId: request.runId,
    runtimeSession: undefined,
    input,
    output: undefined,
    error: undefined,
    upstreamNodeIds,
    downstreamNodeIds,
    trace: [createTrace("node_run_created", { nodeId, runId }, now)],
    createdAt: now,
    updatedAt: now,
  };
}

function upstreamNodeIds(nodeId, edges = []) {
  return edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from);
}

function downstreamNodeIds(nodeId, edges = []) {
  return edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
}

function markReadyNodes(run, now) {
  for (const nodeRun of Object.values(run.nodeRuns || {})) {
    if (nodeRun.status !== "pending") continue;
    if (upstreamSatisfied(run, nodeRun)) {
      nodeRun.status = "ready";
      nodeRun.updatedAt = now;
      nodeRun.trace.push(createTrace("node_run_ready", { nodeId: nodeRun.nodeId }, now));
    }
  }
}

function readyNodeRuns(run) {
  return Object.values(run.nodeRuns || {})
    .filter((nodeRun) => nodeRun.status === "ready")
    .sort((a, b) => topologicalIndex(run.agentSnapshot, a.nodeId) - topologicalIndex(run.agentSnapshot, b.nodeId));
}

function allNodesCompleted(run) {
  return Object.values(run.nodeRuns || {}).every((nodeRun) => nodeRun.status === "completed");
}

function hasFailedRequiredNode(run) {
  return Object.values(run.nodeRuns || {}).some((nodeRun) => {
    if (!["failed", "cancelled"].includes(nodeRun.status)) return false;
    const outgoing = (run.agentSnapshot.edges || []).filter((edge) => edge.from === nodeRun.nodeId);
    if (!outgoing.length) return true;
    return outgoing.some((edge) => edge.required !== false);
  });
}

function upstreamCompleted(run, nodeRun) {
  return upstreamSatisfied(run, nodeRun);
}

function upstreamSatisfied(run, nodeRun) {
  return (nodeRun.upstreamNodeIds || []).every((nodeId) => {
    const upstreamRun = findNodeRunByNodeId(run, nodeId);
    const edge = (run.agentSnapshot.edges || []).find((item) => item.from === nodeId && item.to === nodeRun.nodeId);
    if (edge?.required === false) return ["completed", "failed", "cancelled"].includes(upstreamRun?.status);
    return upstreamRun?.status === "completed";
  });
}

function dagConcurrency(agentSnapshot) {
  const value = Number(agentSnapshot.executionPolicy?.concurrency || agentSnapshot.executionPolicy?.maxConcurrency || 4);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 8) : 4;
}

function topologicalNodeIds(agentSnapshot) {
  if (agentSnapshot.type !== "dag") return ["root"];
  const nodes = agentSnapshot.nodes || [];
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of agentSnapshot.edges || []) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = nodes
    .filter((node) => (incoming.get(node.id) || 0) === 0)
    .map((node) => node.id)
    .sort();
  const result = [];
  while (queue.length) {
    const nodeId = queue.shift();
    result.push(nodeId);
    for (const next of (outgoing.get(nodeId) || []).sort()) {
      incoming.set(next, (incoming.get(next) || 0) - 1);
      if ((incoming.get(next) || 0) === 0) queue.push(next);
    }
    queue.sort();
  }
  return result;
}

function topologicalIndex(agentSnapshot, nodeId) {
  const index = topologicalNodeIds(agentSnapshot).indexOf(nodeId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function findNodeRunByNodeId(run, nodeId) {
  return Object.values(run.nodeRuns || {}).find((nodeRun) => nodeRun.nodeId === nodeId);
}

function buildNodeAgent(agentSnapshot, nodeDef, fallbackAgent) {
  return {
    ...(fallbackAgent || {}),
    id: nodeDef.agentId || agentSnapshot.id || fallbackAgent?.id || "",
    name: nodeDef.name || agentSnapshot.name || fallbackAgent?.name || "DAG Node",
    description: nodeDef.description || agentSnapshot.description || "",
    systemPrompt: [agentSnapshot.systemPrompt, nodeDef.systemPrompt].filter(Boolean).join("\n\n"),
    skills: nodeDef.skills?.length ? nodeDef.skills : agentSnapshot.skills || [],
    mcpServers: nodeDef.mcpServers?.length ? nodeDef.mcpServers : agentSnapshot.mcpServers || [],
    runtimeId: nodeDef.runtimeId || agentSnapshot.runtimeId || fallbackAgent?.runtimeId || config.defaultRuntimeId,
    defaultMode: agentSnapshot.defaultMode || "chat",
    topN: agentSnapshot.topN || 4,
    scoreThreshold: agentSnapshot.scoreThreshold,
  };
}

function buildNodeInput(run, nodeRun, request) {
  const upstreamOutputs = {};
  for (const upstreamNodeId of nodeRun.upstreamNodeIds || []) {
    const upstreamRun = findNodeRunByNodeId(run, upstreamNodeId);
    upstreamOutputs[upstreamNodeId] = summarizeNodeOutput(upstreamRun?.output);
  }
  return {
    task: run.input?.task || "",
    request: {
      runId: request.runId,
      mode: request.mode,
      sessionId: request.sessionId,
    },
    nodeId: nodeRun.nodeId,
    upstreamOutputs,
    originalInput: run.input,
  };
}

function buildDagNodePrompt(project, run, nodeDef, nodeInput) {
  const sections = [
    `你正在 Hippo 工作区「${project.name}」中执行 DAG Agent 节点。`,
    `Agent Run: ${run.id}`,
    `节点: ${nodeDef.name || nodeDef.id} (${nodeDef.id})`,
    nodeDef.description ? `节点说明：\n${nodeDef.description}` : "",
    nodeDef.systemPrompt ? `节点指令：\n${nodeDef.systemPrompt}` : "",
    `原始任务：\n${run.input?.task || ""}`,
    Object.keys(nodeInput.upstreamOutputs || {}).length
      ? `上游节点输出：\n${JSON.stringify(nodeInput.upstreamOutputs, null, 2)}`
      : "当前节点没有上游输出。",
    nodeDef.input !== undefined ? `节点静态输入：\n${JSON.stringify(nodeDef.input, null, 2)}` : "",
    `请只完成当前节点职责，并输出可供下游节点使用的结果。`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function collectDagOutput(run) {
  const terminal = Object.values(run.nodeRuns || {})
    .filter((nodeRun) => !(nodeRun.downstreamNodeIds || []).length)
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  return {
    terminalNodeIds: terminal.map((nodeRun) => nodeRun.nodeId),
    nodes: Object.fromEntries(Object.values(run.nodeRuns || {}).map((nodeRun) => [
      nodeRun.nodeId,
      {
        status: nodeRun.status,
        output: summarizeNodeOutput(nodeRun.output),
        runtimeSession: nodeRun.runtimeSession,
      },
    ])),
  };
}

function summarizeNodeOutput(output) {
  if (!output) return output;
  if (typeof output.text === "string") return output.text;
  if (output.output) return output.output;
  return output;
}

function stringifyDagOutput(output) {
  if (!output) return "";
  return JSON.stringify(output, null, 2);
}

function normalizeAgentRuns(runs) {
  if (!Array.isArray(runs)) return [];
  return runs.map(normalizeAgentRun);
}

function normalizeAgentRun(run) {
  const now = new Date().toISOString();
  const nodeRuns = {};
  for (const [key, value] of Object.entries(run?.nodeRuns || {})) {
    const nodeRun = normalizeNodeRun(value, run.id, now);
    nodeRuns[nodeRun.id || key] = nodeRun;
  }
  return {
    id: run.id || randomUUID(),
    rootSessionId: run.rootSessionId || "",
    workspaceId: run.workspaceId || run.projectId || "",
    agentId: run.agentId || "",
    agentVersion: Number(run.agentVersion || run.agentSnapshot?.version || 1),
    agentSnapshot: snapshotAgentDefinition(run.agentSnapshot || {}),
    status: normalizeRunStatus(run.status),
    input: run.input,
    output: run.output,
    error: run.error,
    request: run.request,
    nodeRuns,
    trace: Array.isArray(run.trace) ? run.trace : [],
    createdAt: run.createdAt || now,
    updatedAt: run.updatedAt || now,
  };
}

function normalizeNodeRun(nodeRun, runId, now) {
  return {
    id: nodeRun.id || `${runId}:${nodeRun.nodeId || "root"}`,
    type: "node",
    runId: nodeRun.runId || runId,
    nodeId: nodeRun.nodeId || "root",
    kind: nodeRun.kind === "wait" ? "wait" : "task",
    agentId: nodeRun.agentId || "",
    status: normalizeNodeStatus(nodeRun.status),
    runtimeRunId: nodeRun.runtimeRunId || "",
    runtimeSession: nodeRun.runtimeSession,
    input: nodeRun.input,
    output: nodeRun.output,
    error: nodeRun.error,
    upstreamNodeIds: Array.isArray(nodeRun.upstreamNodeIds) ? nodeRun.upstreamNodeIds : [],
    downstreamNodeIds: Array.isArray(nodeRun.downstreamNodeIds) ? nodeRun.downstreamNodeIds : [],
    trace: Array.isArray(nodeRun.trace) ? nodeRun.trace : [],
    createdAt: nodeRun.createdAt || now,
    updatedAt: nodeRun.updatedAt || now,
  };
}

function normalizeRunStatus(status) {
  return ["pending", "running", "waiting", "completed", "failed", "cancelled"].includes(status) ? status : "pending";
}

function normalizeNodeStatus(status) {
  return ["pending", "ready", "running", "waiting", "completed", "failed", "cancelled"].includes(status) ? status : "pending";
}

function getPrimaryNodeRun(run) {
  const nodeRun = Object.values(run.nodeRuns || {})[0];
  if (!nodeRun) throw new AgentOrchestratorError(`Agent run ${run.id} has no node runs.`, 500);
  return nodeRun;
}

function createTrace(type, payload, createdAt = new Date().toISOString()) {
  return {
    id: randomUUID(),
    type,
    payload,
    createdAt,
  };
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error || "Unknown error"),
    status: error?.status,
    details: error?.details,
  };
}

function normalizeConversations(conversations) {
  if (!Array.isArray(conversations)) return [];
  return conversations.map(normalizeConversation);
}

function normalizeConversation(conversation) {
  const metadata = conversation.metadata || {};
  const runtimeSessions = normalizeRuntimeSessions(conversation.runtimeSessions || metadata.runtimeSessions);
  return {
    ...conversation,
    type: conversation.type || "root",
    title: conversation.title || deriveConversationTitle(conversation.messages) || "新对话",
    messages: normalizeMessages(conversation.messages),
    activeAgentId: conversation.activeAgentId || metadata.activeAgentId || "",
    runtimeSessions,
    runIds: Array.isArray(conversation.runIds) ? conversation.runIds : [],
    metadata: {
      ...metadata,
      runtimeSessions,
    },
  };
}

function normalizeRuntimeSessions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([provider, session]) => provider && session && typeof session === "object")
      .map(([provider, session]) => [
        provider,
        {
          provider: session.provider || provider,
          sessionId: session.sessionId || "",
          resumedFromSessionId: session.resumedFromSessionId || "",
          workspacePath: session.workspacePath || "",
          hippoSessionId: session.hippoSessionId || "",
          status: session.status || (session.sessionId ? "active" : "ephemeral"),
          contextPolicy: normalizeStoredContextPolicy(session.contextPolicy),
          createdAt: session.createdAt || session.updatedAt || new Date().toISOString(),
          updatedAt: session.updatedAt || new Date().toISOString(),
        },
      ])
  );
}

function normalizeStoredContextPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return { strategy: "runtime", summary: "", summaryUpdatedAt: "" };
  }
  return {
    strategy: ["runtime", "reset", "manual-summary"].includes(policy.strategy) ? policy.strategy : "runtime",
    summary: policy.summary || "",
    summaryUpdatedAt: policy.summaryUpdatedAt || "",
  };
}
