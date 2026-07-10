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

const optionalRuntimeIdSchema = z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().min(1).optional()
);

const agentNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["task", "wait"]).default("task"),
  approvalPolicy: z.enum(["none", "auto", "manual"]).optional(),
  resultApprovalPolicy: z.enum(["none", "auto", "manual"]).optional(),
  runtimeApprovalPolicy: z.enum(["inherit", "untrusted", "on-request", "never"]).default("inherit"),
  transitionInstruction: z.string().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  agentId: z.string().optional(),
  systemPrompt: z.string().optional(),
  runtimeId: optionalRuntimeIdSchema,
  skills: z.array(skillSchema).default([]),
  mcpServers: z.array(z.string().min(1)).default([]),
  input: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const agentEdgeSchema = z.object({
  id: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
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

const dispatchGraphNodeSchema = z.object({
  nodeId: z.string().min(1),
  input: z.unknown().optional(),
  parentNodeRunId: z.string().min(1).optional(),
  reason: z.string().optional(),
});

const requestUserSchema = z.object({
  question: z.string().min(1),
  reason: z.string().optional(),
});

const resolveGraphRunSchema = z.object({
  output: z.unknown().optional(),
  reason: z.string().optional(),
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
    return workspaceResultList(store.projects);
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
    return workspaceResult(project);
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
    const updated = await this.coordinateGraphRun(project, run.agentSnapshot, request, runId);
    return { project, run: updated.run };
  }

  async dispatchGraphNode(projectId, runId, input = {}, onEvent) {
    const payload = dispatchGraphNodeSchema.parse(input);
    const { project } = await this.getProject(projectId);
    const { run } = await this.getAgentRun(projectId, runId);
    if (run.agentSnapshot?.type !== "dag") {
      throw new AgentOrchestratorError("Only graph runs can dispatch nodes.", 400);
    }
    if (payload.nodeId === run.agentSnapshot.rootNodeId) {
      throw new AgentOrchestratorError("Root is the coordinator and cannot be dispatched as a worker node.", 400);
    }
    const nodeDef = run.agentSnapshot.nodes.find((node) => node.id === payload.nodeId);
    if (!nodeDef) throw new AgentOrchestratorError(`Graph node ${payload.nodeId} was not found.`, 404);
    let nodeRun;
    await this.updateAgentRun(projectId, runId, (current, updatedAt) => {
      if (["completed", "failed", "cancelled"].includes(current.status)) {
        throw new AgentOrchestratorError(`Run ${runId} is already ${current.status}.`, 409);
      }
      const attempt = Object.values(current.nodeRuns || {})
        .filter((item) => item.prototypeNodeId === payload.nodeId || item.nodeId === payload.nodeId)
        .length + 1;
      nodeRun = createNodeRun({
        runId,
        request: current.request,
        agentSnapshot: current.agentSnapshot,
        nodeId: payload.nodeId,
        kind: nodeDef.kind || "task",
        input: payload.input,
        upstreamNodeIds: [],
        downstreamNodeIds: downstreamNodeIds(payload.nodeId, current.agentSnapshot.edges),
        attempt,
        parentNodeRunId: payload.parentNodeRunId || "",
        now: updatedAt,
      });
      nodeRun.status = "pending";
      current.nodeRuns[nodeRun.id] = nodeRun;
      current.status = "running";
      current.trace.push(createTrace("graph_node_dispatched", {
        nodeRunId: nodeRun.id,
        nodeId: payload.nodeId,
        attempt: nodeRun.attempt,
        parentNodeRunId: payload.parentNodeRunId || "",
        reason: payload.reason || "",
      }, updatedAt));
      return current;
    });
    const request = run.request || {
      runtimeId: run.agentSnapshot.runtimeId || config.defaultRuntimeId,
      runId: run.id,
      projectId,
      mode: run.agentSnapshot.defaultMode || "chat",
      sessionId: run.rootSessionId,
      runtimeOptions: {},
    };
    const result = await this.executeDagNode(project, run.agentSnapshot, request, runId, nodeRun.id, onEvent)
      .catch(() => undefined);
    return { project, ...(await this.getAgentRun(projectId, runId)), nodeRunId: nodeRun.id, result };
  }

  async retryNodeRun(projectId, runId, input = {}) {
    const payload = retryNodeRunSchema.parse(input);
    const { run } = await this.getAgentRun(projectId, runId);
    const nodeRun = payload.nodeRunId
      ? run.nodeRuns?.[payload.nodeRunId]
      : findLatestNodeRunByPrototype(run, payload.nodeId);
    if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
    return this.dispatchGraphNode(projectId, runId, {
      nodeId: nodeRun.prototypeNodeId || nodeRun.nodeId,
      input: nodeRun.input?.dispatchInput ?? nodeRun.input,
      parentNodeRunId: nodeRun.id,
      reason: "Root coordinator requested a retry.",
    });
  }

  async resumeNodeRun(projectId, runId, input = {}) {
    const payload = resumeNodeRunSchema.parse(input);
    const { run } = await this.getAgentRun(projectId, runId);
    const nodeRun = payload.nodeRunId
      ? run.nodeRuns?.[payload.nodeRunId]
      : findLatestNodeRunByPrototype(run, payload.nodeId);
    if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
    if (!["waiting", "waiting_approval"].includes(nodeRun.status)) {
      throw new AgentOrchestratorError("Only node runs waiting for approval can be resumed.", 400);
    }
    await this.updateAgentRun(projectId, runId, (current, now) => {
      const currentNode = current.nodeRuns[nodeRun.id];
      currentNode.status = "completed";
      currentNode.approval = { resumed: true, value: payload.output, updatedAt: now };
      currentNode.updatedAt = now;
      currentNode.trace.push(createTrace("node_run_resumed", {
        nodeRunId: nodeRun.id,
        nodeId: currentNode.nodeId,
        output: payload.output,
      }, now));
      current.status = graphRunStatusAfterNodeUpdate(current);
      current.trace.push(createTrace("agent_run_resumed", { runId, nodeRunId: nodeRun.id }, now));
      return current;
    });
    return this.advanceGraphRun(projectId, runId);
  }

  async requestGraphRunUser(projectId, runId, input = {}) {
    const payload = requestUserSchema.parse(input);
    return this.updateAgentRun(projectId, runId, (run, now) => {
      assertGraphRunMutable(run);
      run.status = "waiting_user";
      run.output = { kind: "user_request", question: payload.question, reason: payload.reason || "" };
      run.rootCoordinator.status = "waiting_user";
      run.rootCoordinator.updatedAt = now;
      run.trace.push(createTrace("graph_run_user_requested", payload, now));
      return run;
    });
  }

  async resumeGraphRunWithUserInput(projectId, runId, input = {}, onEvent) {
    const userInput = input.input ?? input.message ?? input.text;
    if (userInput === undefined || userInput === "") {
      throw new AgentOrchestratorError("A user response is required to resume the graph run.", 400);
    }
    const { project } = await this.getProject(projectId);
    const { run } = await this.getAgentRun(projectId, runId);
    if (run.status !== "waiting_user") {
      throw new AgentOrchestratorError("Only graph runs waiting for user input can be resumed.", 409);
    }
    await this.updateAgentRun(projectId, runId, (current, now) => {
      current.status = "coordinating";
      current.output = undefined;
      current.userResponses = [...(current.userResponses || []), { input: userInput, createdAt: now }];
      current.rootCoordinator.status = "ready";
      current.rootCoordinator.updatedAt = now;
      current.trace.push(createTrace("graph_run_user_resumed", { input: userInput }, now));
      return current;
    });
    const request = run.request || {
      runtimeId: run.agentSnapshot.runtimeId || config.defaultRuntimeId,
      runId: run.id,
      projectId,
      sessionId: run.rootSessionId,
      runtimeOptions: {},
    };
    const completedRun = await this.coordinateGraphRun(project, run.agentSnapshot, request, runId, onEvent);
    const result = {
      runtimeId: request.runtimeId,
      runId,
      text: completedRun.run.status === "waiting_user"
        ? completedRun.run.output?.question || "RootAgent 正在等待用户输入。"
        : stringifyDagOutput(completedRun.run.output),
      output: completedRun.run.output,
    };
    onEvent?.({ type: "done", project, agent: run.agentSnapshot, request, result, agentRun: completedRun.run });
    return { project, agent: run.agentSnapshot, request, result, agentRun: completedRun.run, run: completedRun.run };
  }

  async completeGraphRun(projectId, runId, input = {}) {
    const payload = resolveGraphRunSchema.parse(input);
    const { run } = await this.getAgentRun(projectId, runId);
    assertGraphRunMutable(run);
    return this.completeDagRun(projectId, runId, {
      status: "completed",
      output: payload.output === undefined ? collectDagOutput(run) : payload.output,
    });
  }

  async failGraphRun(projectId, runId, input = {}) {
    const payload = resolveGraphRunSchema.parse(input);
    assertGraphRunMutable((await this.getAgentRun(projectId, runId)).run);
    return this.completeDagRun(projectId, runId, {
      status: "failed",
      output: payload.output,
      error: { message: payload.reason || "Root coordinator marked the run as failed." },
    });
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
    return workspaceResult(project);
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
    return workspaceResult(updated);
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
    return { deleted: true, id, workspaceId: id, projectId: id, deletedConversations, deletedRuns };
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
    if (rootSession?.id) {
      const waitingRun = (await this.listAgentRuns(project.id, { rootSessionId: rootSession.id })).runs
        .find((run) => run.agentId === agent.id && run.status === "waiting_user");
      if (waitingRun) {
        return this.resumeGraphRunWithUserInput(project.id, waitingRun.id, { input: payload.task }, onEvent);
      }
    }
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
      const completedRun = await this.coordinateGraphRun(project, agent, request, agentRun.id, onEvent);
      const result = {
        runtimeId: request.runtimeId,
        runId: agentRun.id,
        text: completedRun.run.status === "waiting_user"
          ? completedRun.run.output?.question || "RootAgent 正在等待用户输入。"
          : stringifyDagOutput(completedRun.run.output),
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
    if (run.rootCoordinator?.status === "running" && run.rootCoordinator.runtimeRunId) {
      cancellations.push(this.cancelRuntimeRun(run.rootCoordinator.runtimeRunId));
    }
    for (const nodeRun of Object.values(run.nodeRuns || {})) {
      if (nodeRun.status === "running" && nodeRun.runtimeRunId) {
        cancellations.push(this.cancelRuntimeRun(nodeRun.runtimeRunId));
      }
      if (["pending", "ready", "running", "waiting", "waiting_approval"].includes(nodeRun.status)) {
        nodeRun.status = "cancelled";
        nodeRun.updatedAt = now;
        nodeRun.trace.push(createTrace("node_run_cancelled", { nodeRunId: nodeRun.id }, now));
      }
    }
    cancellations.push(this.cancelRuntimeRun(runId));
    run.status = "cancelled";
    run.error = { message: "Agent run was cancelled." };
    if (run.rootCoordinator) {
      run.rootCoordinator.status = "cancelled";
      run.rootCoordinator.runtimeRunId = "";
      run.rootCoordinator.updatedAt = now;
    }
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
      rootCoordinator: agentSnapshot.type === "dag" ? {
        prototypeNodeId: agentSnapshot.rootNodeId,
        status: "pending",
        decisionCount: 0,
        runtimeSession: undefined,
        lastDecision: undefined,
        updatedAt: now,
      } : undefined,
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
        prototype: {
          rootNodeId: run.agentSnapshot.rootNodeId,
          nodes: run.agentSnapshot.nodes,
          edges: run.agentSnapshot.edges,
        },
      };
      run.rootCoordinator.status = "completed";
      run.rootCoordinator.updatedAt = now;
      run.trace.push(createTrace("agent_run_dry_completed", { runId }, now));
      return run;
    });
  }

  async coordinateGraphRun(project, agent, request, runId, onEvent) {
    const maxDecisions = Math.max(1, Number(agent.executionPolicy?.maxDecisions || 50));
    while (true) {
      const { run } = await this.getAgentRun(project.id, runId);
      if (["completed", "failed", "cancelled", "waiting_user", "waiting_approval"].includes(run.status)) {
        return { run };
      }
      if ((run.rootCoordinator?.decisionCount || 0) >= maxDecisions) {
        return this.completeDagRun(project.id, runId, {
          status: "failed",
          error: { message: `Root coordinator exceeded the ${maxDecisions} decision limit.` },
        });
      }

      const rootNode = run.agentSnapshot.nodes.find((node) => node.id === run.agentSnapshot.rootNodeId);
      if (!rootNode) throw new AgentOrchestratorError("Root coordinator node was not found in the agent snapshot.", 500);
      const runtimeId = rootNode.runtimeId || run.agentSnapshot.runtimeId || request.runtimeId;
      const runtime = this.runtimeRegistry.getRuntime(runtimeId);
      const rootSession = await this.getRootRuntimeSession(project.id, run);
      const coordinatorRunId = `${runId}:root:${(run.rootCoordinator?.decisionCount || 0) + 1}`;
      const runtimeApprovalPolicy = resolveNodeRuntimeApprovalPolicy(
        rootNode.runtimeApprovalPolicy,
        request.runtimeOptions?.runtimeApprovalPolicy
      );
      const prompt = buildRootCoordinatorPrompt(project, run, rootNode, { nativeGraphTools: runtimeId === "codex" });
      const rootAgent = buildRootCoordinatorAgent(run.agentSnapshot, rootNode);

      await this.updateAgentRun(project.id, runId, (current, now) => {
        current.status = "coordinating";
        current.rootCoordinator.status = "running";
        current.rootCoordinator.runtimeRunId = coordinatorRunId;
        current.rootCoordinator.updatedAt = now;
        current.trace.push(createTrace("root_coordinator_started", { coordinatorRunId }, now));
        return current;
      });
      onEvent?.({ type: "root_coordinator_started", runId, coordinatorRunId });

      let result;
      let decision;
      try {
        result = await runtime.execute({
          project,
          agent: rootAgent,
          prompt,
          rootSession,
          reset: false,
          runId: coordinatorRunId,
          contextPolicy: {
            strategy: "runtime",
            rootSessionId: run.rootSessionId,
            previousRuntimeSessionId: rootSession?.runtimeSessions?.codex?.sessionId || "",
          },
          runtimeOptions: {
            ...request.runtimeOptions,
            runtimeApprovalPolicy,
            mcpServerUrls: {
              ...(request.runtimeOptions?.mcpServerUrls || {}),
              hippo: `http://127.0.0.1:${config.wrapperPort}/mcp`,
            },
            ignoreUserConfig: true,
          },
        });
      } catch (error) {
        return this.completeDagRun(project.id, runId, {
          status: "failed",
          error: serializeError(error),
        });
      }

      await this.persistRuntimeSession(project.id, run.rootSessionId, result.runtimeSession, run.agentId, runId);
      const afterNativeTools = (await this.getAgentRun(project.id, runId)).run;
      if (["completed", "failed", "cancelled", "waiting_user", "waiting_approval"].includes(afterNativeTools.status)) {
        const updated = await this.updateAgentRun(project.id, runId, (current, now) => {
          current.rootCoordinator.decisionCount += 1;
          current.rootCoordinator.runtimeSession = result.runtimeSession;
          current.rootCoordinator.runtimeRunId = "";
          current.rootCoordinator.lastDecision = { action: "mcp_tool_managed" };
          current.rootCoordinator.updatedAt = now;
          for (const event of result.events || []) {
            current.trace.push(createTrace(event.type || "root_runtime_event", event, now));
          }
          current.trace.push(createTrace("root_coordinator_tool_managed", { runtimeSession: result.runtimeSession }, now));
          return current;
        });
        return updated;
      }

      decision = parseRootCoordinatorDecision(result.text);
      await this.updateAgentRun(project.id, runId, (current, now) => {
        current.status = "coordinating";
        current.rootCoordinator.status = "ready";
        current.rootCoordinator.decisionCount += 1;
        current.rootCoordinator.runtimeSession = result.runtimeSession;
        current.rootCoordinator.runtimeRunId = "";
        current.rootCoordinator.lastDecision = decision;
        current.rootCoordinator.updatedAt = now;
        for (const event of result.events || []) {
          current.trace.push(createTrace(event.type || "root_runtime_event", event, now));
        }
        current.trace.push(createTrace("root_coordinator_decision", { decision, runtimeSession: result.runtimeSession }, now));
        return current;
      });
      onEvent?.({ type: "root_coordinator_decision", runId, decision });

      if (decision.action === "dispatch" || decision.action === "retry") {
        await this.dispatchGraphNode(project.id, runId, {
          nodeId: decision.nodeId,
          input: decision.input,
          parentNodeRunId: decision.parentNodeRunId,
          reason: decision.reason,
        }, onEvent);
        continue;
      }
      if (decision.action === "dispatch_many") {
        const nodes = Array.isArray(decision.nodes) ? decision.nodes : [];
        if (!nodes.length) throw new AgentOrchestratorError("dispatch_many requires at least one node.", 400);
        await Promise.all(nodes.map((item) => this.dispatchGraphNode(project.id, runId, {
          nodeId: item.nodeId,
          input: item.input,
          parentNodeRunId: item.parentNodeRunId,
          reason: item.reason || decision.reason,
        }, onEvent)));
        continue;
      }
      if (decision.action === "request_user") {
        return this.requestGraphRunUser(project.id, runId, {
          question: decision.question,
          reason: decision.reason,
        });
      }
      if (decision.action === "complete") {
        return this.completeGraphRun(project.id, runId, { output: decision.output, reason: decision.reason });
      }
      if (decision.action === "fail") {
        return this.failGraphRun(project.id, runId, { output: decision.output, reason: decision.reason });
      }
      return this.completeDagRun(project.id, runId, {
        status: "failed",
        error: { message: `Unsupported Root coordinator action: ${decision.action}` },
      });
    }
  }

  async getRootRuntimeSession(projectId, run) {
    if (run.rootSessionId) {
      try {
        return (await this.getConversation(projectId, run.rootSessionId)).conversation;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    const runtimeSession = run.rootCoordinator?.runtimeSession;
    return runtimeSession ? {
      id: run.rootSessionId || `root:${run.id}`,
      runtimeSessions: { [runtimeSession.provider || "codex"]: runtimeSession },
    } : undefined;
  }

  async executeDagNode(project, agent, request, runId, nodeRunId, onEvent) {
    const { run, nodeRun } = await this.getNodeRun(project.id, runId, nodeRunId);
    const nodeDef = run.agentSnapshot.nodes.find((node) => node.id === nodeRun.nodeId);
    if (!nodeDef) throw new AgentOrchestratorError(`DAG node ${nodeRun.nodeId} was not found in snapshot.`, 500);
    const nodeRuntimeId = nodeDef.runtimeId || run.agentSnapshot.runtimeId || request.runtimeId;
    const runtime = this.runtimeRegistry.getRuntime(nodeRuntimeId);
    const runtimeRunId = `${nodeRun.id}:${randomUUID()}`;
    const nodeAgent = buildNodeAgent(run.agentSnapshot, nodeDef, agent);
    const nodeInput = buildNodeInput(run, nodeRun, request);
    const prompt = buildDagNodePrompt(project, run, nodeDef, nodeInput);
    const runtimeApprovalPolicy = resolveNodeRuntimeApprovalPolicy(
      nodeDef.runtimeApprovalPolicy,
      request.runtimeOptions?.runtimeApprovalPolicy
    );

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
        runtimeOptions: {
          ...request.runtimeOptions,
          runtimeApprovalPolicy,
        },
      });
      const resultApprovalPolicy = normalizeResultApprovalPolicy(nodeDef.resultApprovalPolicy);
      const updated = await this.updateAgentRun(project.id, runId, (current, now) => {
        const currentNode = current.nodeRuns[nodeRunId];
        currentNode.status = resultApprovalPolicy === "manual" ? "waiting_approval" : "completed";
        currentNode.output = result;
        currentNode.runtimeSession = result.runtimeSession;
        currentNode.updatedAt = now;
        const trace = createTrace(resultApprovalPolicy === "manual" ? "node_run_approval_waiting" : "node_run_completed", {
          nodeRunId,
          nodeId: currentNode.nodeId,
          runtimeRunId,
          runtimeSession: result.runtimeSession,
          resultApprovalPolicy,
          runtimeApprovalPolicy,
        }, now);
        current.trace.push(trace);
        currentNode.trace.push(trace);
        for (const event of result.events || []) {
          const eventTrace = createTrace(event.type || "runtime_event", event, now);
          current.trace.push(eventTrace);
          currentNode.trace.push(eventTrace);
        }
        current.status = graphRunStatusAfterNodeUpdate(current);
        return current;
      });
      onEvent?.({
        type: resultApprovalPolicy === "manual" ? "dag_node_waiting" : "dag_node_completed",
        runId,
        nodeRunId,
        nodeId: nodeRun.nodeId,
        result,
        prompt: resultApprovalPolicy === "manual" ? `${nodeDef.name || nodeRun.nodeId} 等待结果审核` : undefined,
      });
      return updated;
    } catch (error) {
      const status = error.status === 499 || error.details?.cancelled ? "cancelled" : "failed";
      await this.updateAgentRun(project.id, runId, (current, now) => {
        const currentNode = current.nodeRuns[nodeRunId];
        currentNode.status = status;
        currentNode.error = serializeError(error);
        currentNode.updatedAt = now;
        current.status = graphRunStatusAfterNodeUpdate(current);
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
      assertGraphRunMutable(run);
      run.status = status;
      run.output = output || run.output;
      run.error = error;
      if (run.rootCoordinator) {
        run.rootCoordinator.status = status;
        run.rootCoordinator.updatedAt = now;
      }
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
  return nodes.map((node) => stripEmptyObject({
    id: String(node.id || "").trim(),
    kind: "task",
    resultApprovalPolicy: normalizeResultApprovalPolicy(
      node.resultApprovalPolicy || node.approvalPolicy || node.approval || (node.kind === "wait" ? "manual" : "")
    ),
    runtimeApprovalPolicy: normalizeRuntimeApprovalPolicy(node.runtimeApprovalPolicy),
    transitionInstruction: node.transitionInstruction || node.routingInstruction || "",
    name: node.name || node.id || "",
    description: node.description || "",
    agentId: node.agentId || "",
    systemPrompt: node.systemPrompt || "",
    runtimeId: node.runtimeId || undefined,
    skills: Array.isArray(node.skills) ? node.skills : [],
    mcpServers: Array.isArray(node.mcpServers) ? node.mcpServers : [],
    input: node.input,
    metadata: node.metadata || {},
  })).filter((node) => node.id);
}

function normalizeResultApprovalPolicy(value) {
  return ["manual", "auto", "none"].includes(value) ? value : "none";
}

function normalizeRuntimeApprovalPolicy(value) {
  return ["untrusted", "on-request", "never"].includes(value) ? value : "inherit";
}

function resolveNodeRuntimeApprovalPolicy(nodePolicy, inheritedPolicy) {
  const normalized = normalizeRuntimeApprovalPolicy(nodePolicy);
  return normalized === "inherit" ? normalizeRuntimeApprovalPolicy(inheritedPolicy) : normalized;
}

function normalizeAgentEdges(edges) {
  if (!Array.isArray(edges)) return [];
  return edges.map((edge) => ({
    id: edge.id || `${edge.from}->${edge.to}`,
    from: String(edge.from || "").trim(),
    to: String(edge.to || "").trim(),
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
  const edgeKeys = new Set();
  for (const edge of normalized.edges) {
    const key = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) {
      throw new AgentOrchestratorError(`DAG has duplicate edge: ${key}.`, 400);
    }
    edgeKeys.add(key);
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
  return {};
}

function createNodeRun({
  runId,
  request,
  agentSnapshot,
  nodeId,
  kind = "task",
  input,
  upstreamNodeIds,
  downstreamNodeIds,
  attempt = 1,
  parentNodeRunId = "",
  now,
}) {
  return {
    id: `${runId}:${nodeId || "root"}${agentSnapshot.type === "dag" ? `:${attempt}` : ""}`,
    type: "node",
    runId,
    nodeId: nodeId || "root",
    kind,
    prototypeNodeId: nodeId || "root",
    attempt,
    parentNodeRunId,
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

function downstreamNodeIds(nodeId, edges = []) {
  return edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
}

function graphRunStatusAfterNodeUpdate(run) {
  const statuses = Object.values(run.nodeRuns || {}).map((nodeRun) => nodeRun.status);
  if (statuses.some((status) => ["pending", "ready", "running"].includes(status))) return "running";
  if (statuses.some((status) => ["waiting", "waiting_approval"].includes(status))) return "waiting_approval";
  return "coordinating";
}

function findLatestNodeRunByPrototype(run, nodeId) {
  return Object.values(run.nodeRuns || {})
    .filter((nodeRun) => (nodeRun.prototypeNodeId || nodeRun.nodeId) === nodeId)
    .sort((a, b) => (Number(b.attempt) || 1) - (Number(a.attempt) || 1))[0];
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

function buildRootCoordinatorAgent(agentSnapshot, rootNode) {
  return {
    id: agentSnapshot.id || "root-coordinator",
    name: `${agentSnapshot.name || "Agent"} Root Coordinator`,
    description: "Owns the Agent prototype view and coordinates the persisted runtime graph.",
    systemPrompt: [
      agentSnapshot.systemPrompt,
      rootNode.systemPrompt,
      "你是 RootAgent，唯一负责读取运行图、判断节点结果并决定下一步调度。不要执行普通工作节点的职责。",
    ].filter(Boolean).join("\n\n"),
    skills: rootNode.skills?.length ? rootNode.skills : agentSnapshot.skills || [],
    mcpServers: rootNode.mcpServers?.length ? rootNode.mcpServers : agentSnapshot.mcpServers || [],
    runtimeId: rootNode.runtimeId || agentSnapshot.runtimeId || config.defaultRuntimeId,
  };
}

function buildRootCoordinatorPrompt(project, run, rootNode, { nativeGraphTools = false } = {}) {
  const prototype = {
    rootNodeId: run.agentSnapshot.rootNodeId,
    nodes: run.agentSnapshot.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      interfaceDescription: node.description,
      transitionInstruction: node.transitionInstruction || "",
    })),
    edges: run.agentSnapshot.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  };
  const runtimeGraph = Object.values(run.nodeRuns || {}).map((nodeRun) => {
    const node = run.agentSnapshot.nodes.find((item) => item.id === nodeRun.prototypeNodeId);
    return {
      nodeRunId: nodeRun.id,
      nodeId: nodeRun.prototypeNodeId,
      attempt: nodeRun.attempt,
      parentNodeRunId: nodeRun.parentNodeRunId,
      status: nodeRun.status,
      input: nodeRun.input,
      output: summarizeNodeOutput(nodeRun.output),
      error: nodeRun.error,
      transitionInstruction: node?.transitionInstruction || "",
    };
  });
  return [
    `你正在协调 Hippo 工作区「${project.name}」中的 Agent Run。`,
    "你是 RootAgent，也是这个 Run 的唯一调度决策者。你只负责读取原型和运行图、判断节点结果并选择下一条 Graph Tool 命令，不要代替普通节点执行任务。",
    run.agentSnapshot.systemPrompt ? `Agent 全局指令：\n${run.agentSnapshot.systemPrompt}` : "",
    rootNode.systemPrompt ? `RootAgent 指令：\n${rootNode.systemPrompt}` : "",
    `Run ID: ${run.id}`,
    `原始任务：\n${run.input?.task || ""}`,
    `Agent 图原型：\n${JSON.stringify(prototype, null, 2)}`,
    `当前 Runtime Graph：\n${JSON.stringify(runtimeGraph, null, 2)}`,
    run.userResponses?.length ? `用户后续回复：\n${JSON.stringify(run.userResponses, null, 2)}` : "当前没有用户后续回复。",
    rootNode.transitionInstruction ? `Root 结果处置规则：\n${rootNode.transitionInstruction}` : "Root 未配置额外结果处置规则，按默认拓扑开始调度。",
    `调用 Hippo MCP Graph Tool 推进运行：hippo_get_agent_run、hippo_dispatch_graph_node、hippo_request_graph_user、hippo_complete_graph_run、hippo_fail_graph_run。所有工具参数中的 workspaceId 使用 ${project.id}，runId 使用 ${run.id}。你可以连续调用节点，直到 Run 完成、失败、等待审批或等待用户。`,
    nativeGraphTools
      ? "当前 Codex runtime 已注入并验证 Hippo MCP。必须调用上述 Graph Tool，禁止声称工具不可用，禁止直接输出 JSON 降级命令。"
      : `如果当前 runtime 无法调用 Hippo MCP，则根据节点输入、输出、状态和 transitionInstruction 只输出一个 JSON 对象作为降级命令，不要使用 Markdown。\n可用动作：\n` +
      `{"action":"dispatch","nodeId":"节点ID","input":{},"parentNodeRunId":"可选","reason":"原因"}\n` +
      `{"action":"dispatch_many","nodes":[{"nodeId":"节点ID","input":{}}],"reason":"原因"}\n` +
      `{"action":"retry","nodeId":"节点ID","input":{},"parentNodeRunId":"失败的NodeRun ID","reason":"原因"}\n` +
      `{"action":"request_user","question":"需要用户回答的问题","reason":"原因"}\n` +
      `{"action":"complete","output":{},"reason":"完成原因"}\n` +
      `{"action":"fail","reason":"失败原因"}`,
  ].join("\n\n");
}

function parseRootCoordinatorDecision(text) {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1);
  let decision;
  try {
    decision = JSON.parse(candidate);
  } catch (error) {
    throw new AgentOrchestratorError("Root coordinator did not return a valid JSON decision.", 502, {
      response: source,
      parseError: error.message,
    });
  }
  const actions = ["dispatch", "dispatch_many", "retry", "request_user", "complete", "fail"];
  if (!decision || !actions.includes(decision.action)) {
    throw new AgentOrchestratorError("Root coordinator returned an unsupported decision.", 502, decision);
  }
  if (["dispatch", "retry"].includes(decision.action) && !decision.nodeId) {
    throw new AgentOrchestratorError(`${decision.action} requires nodeId.`, 502, decision);
  }
  if (decision.action === "request_user" && !decision.question) {
    throw new AgentOrchestratorError("request_user requires question.", 502, decision);
  }
  return decision;
}

function buildNodeInput(run, nodeRun, request) {
  const parent = nodeRun.parentNodeRunId ? run.nodeRuns?.[nodeRun.parentNodeRunId] : undefined;
  return {
    task: run.input?.task || "",
    request: {
      runId: request.runId,
      mode: request.mode,
      sessionId: request.sessionId,
    },
    nodeId: nodeRun.nodeId,
    attempt: nodeRun.attempt,
    dispatchInput: nodeRun.input,
    parent: parent ? {
      nodeRunId: parent.id,
      nodeId: parent.prototypeNodeId || parent.nodeId,
      status: parent.status,
      output: summarizeNodeOutput(parent.output),
      error: parent.error,
    } : undefined,
    originalInput: run.input,
  };
}

function buildDagNodePrompt(project, run, nodeDef, nodeInput) {
  const sections = [
    `你正在 Hippo 工作区「${project.name}」中执行 DAG Agent 节点。`,
    `Agent Run: ${run.id}`,
    `节点: ${nodeDef.name || nodeDef.id} (${nodeDef.id})`,
    run.agentSnapshot.systemPrompt ? `Agent 全局指令：\n${run.agentSnapshot.systemPrompt}` : "",
    nodeDef.description ? `节点接口描述：\n${nodeDef.description}` : "",
    nodeDef.systemPrompt ? `节点系统提示词：\n${nodeDef.systemPrompt}` : "",
    `原始任务：\n${run.input?.task || ""}`,
    nodeInput.dispatchInput !== undefined ? `RootAgent 派发输入：\n${JSON.stringify(nodeInput.dispatchInput, null, 2)}` : "RootAgent 未提供额外派发输入。",
    nodeInput.parent ? `触发本次执行的父 NodeRun：\n${JSON.stringify(nodeInput.parent, null, 2)}` : "当前执行没有指定父 NodeRun。",
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
    rootCoordinator: normalizeRootCoordinator(run.rootCoordinator, run.agentSnapshot, now),
    userResponses: Array.isArray(run.userResponses) ? run.userResponses : [],
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
    prototypeNodeId: nodeRun.prototypeNodeId || nodeRun.nodeId || "root",
    attempt: Math.max(1, Number(nodeRun.attempt) || 1),
    parentNodeRunId: nodeRun.parentNodeRunId || "",
    kind: nodeRun.kind === "wait" ? "wait" : "task",
    agentId: nodeRun.agentId || "",
    status: normalizeNodeStatus(nodeRun.status),
    runtimeRunId: nodeRun.runtimeRunId || "",
    runtimeSession: nodeRun.runtimeSession,
    input: nodeRun.input,
    output: nodeRun.output,
    error: nodeRun.error,
    approval: nodeRun.approval,
    upstreamNodeIds: Array.isArray(nodeRun.upstreamNodeIds) ? nodeRun.upstreamNodeIds : [],
    downstreamNodeIds: Array.isArray(nodeRun.downstreamNodeIds) ? nodeRun.downstreamNodeIds : [],
    trace: Array.isArray(nodeRun.trace) ? nodeRun.trace : [],
    createdAt: nodeRun.createdAt || now,
    updatedAt: nodeRun.updatedAt || now,
  };
}

function normalizeRunStatus(status) {
  return [
    "pending",
    "coordinating",
    "running",
    "waiting",
    "waiting_approval",
    "waiting_user",
    "completed",
    "failed",
    "cancelled",
  ].includes(status) ? status : "pending";
}

function assertGraphRunMutable(run) {
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    throw new AgentOrchestratorError(`Run ${run.id} is already ${run.status}.`, 409);
  }
}

function normalizeRootCoordinator(value, agentSnapshot, now) {
  if (agentSnapshot?.type !== "dag") return undefined;
  return {
    prototypeNodeId: value?.prototypeNodeId || agentSnapshot.rootNodeId || "root",
    status: value?.status || "pending",
    decisionCount: Math.max(0, Number(value?.decisionCount) || 0),
    runtimeSession: value?.runtimeSession,
    runtimeRunId: value?.runtimeRunId || "",
    lastDecision: value?.lastDecision,
    updatedAt: value?.updatedAt || now,
  };
}

function workspaceResult(workspace) {
  return { workspace, project: workspace };
}

function workspaceResultList(workspaces) {
  return { workspaces, projects: workspaces };
}

function normalizeNodeStatus(status) {
  return ["pending", "ready", "running", "waiting", "waiting_approval", "completed", "failed", "cancelled"].includes(status)
    ? status
    : "pending";
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
