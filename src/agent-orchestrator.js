import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { RuntimeRegistry } from "./runtime-adapter.js";
import { ContextStore } from "./context-store.js";
import { SqliteStateStore } from "./storage/sqlite-state-store.js";
import {
  AGENT_BLUEPRINT_SCHEMA_ID,
  AGENT_BLUEPRINT_SCHEMA_VERSION,
  getAgentBlueprintSchema,
  validateAgentBlueprintSchema,
} from "./agent-blueprint-schema.js";

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
}).strict();

const mcpServersSchema = z.array(z.string().min(1)).refine(
  (items) => new Set(items).size === items.length,
  { message: "MCP server names must be unique." }
);

const nodeRagSchema = z.object({
  enabled: z.boolean().default(false),
  topN: z.number().int().min(1).max(100).default(4),
}).strict();

const executionPolicySchema = z.object({
  maxDecisions: z.number().int().min(1).max(1000).default(50),
}).strict();

const agentNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("task").default("task"),
  resultApprovalPolicy: z.enum(["none", "auto", "manual"]).optional(),
  runtimeApprovalPolicy: z.enum(["inherit", "untrusted", "on-request", "never"]).default("inherit"),
  transitionInstruction: z.string().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  agentId: z.string().optional(),
  systemPrompt: z.string().optional(),
  runtimeId: z.string().min(1).optional(),
  rag: nodeRagSchema.optional(),
  skills: z.array(skillSchema).default([]),
  mcpServers: mcpServersSchema.default([]),
  input: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const agentEdgeSchema = z.object({
  id: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  hippoMcpEnabled: z.boolean().default(false),
  agentIds: z.array(z.string().min(1)).default([]),
  knowledgeDomainRefs: z.array(z.string().min(1)).default([]),
  knowledgeTopicRefs: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  hippoMcpEnabled: z.boolean().optional(),
  agentIds: z.array(z.string().min(1)).optional(),
  knowledgeDomainRefs: z.array(z.string().min(1)).optional(),
  knowledgeTopicRefs: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  runId: z.string().optional(),
  agentRunSummary: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
  attachments: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["file", "folder", "image"]),
    name: z.string().min(1),
    path: z.string().min(1),
    mimeType: z.string().optional(),
    size: z.number().nonnegative().optional(),
    childCount: z.number().int().nonnegative().optional(),
  }).strict()).default([]),
}).strict();

const createConversationSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  messages: z.array(messageSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const updateConversationSchema = z.object({
  title: z.string().optional(),
  messages: z.array(messageSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const branchConversationSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
}).strict();

const createAgentSchema = z.object({
  $schema: z.literal(AGENT_BLUEPRINT_SCHEMA_ID).default(AGENT_BLUEPRINT_SCHEMA_ID),
  schemaVersion: z.literal(AGENT_BLUEPRINT_SCHEMA_VERSION).default(AGENT_BLUEPRINT_SCHEMA_VERSION),
  type: z.enum(["single", "blueprint"]).default("single"),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(skillSchema).default([]),
  mcpServers: mcpServersSchema.default([]),
  runtimeId: z.string().min(1).default(config.defaultRuntimeId),
  rag: nodeRagSchema.default({ enabled: false, topN: 4 }),
  rootNodeId: z.string().optional(),
  nodes: z.array(agentNodeSchema).default([]),
  edges: z.array(agentEdgeSchema).default([]),
  executionPolicy: executionPolicySchema.default({ maxDecisions: 50 }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const updateAgentSchema = z.object({
  $schema: z.literal(AGENT_BLUEPRINT_SCHEMA_ID).optional(),
  schemaVersion: z.literal(AGENT_BLUEPRINT_SCHEMA_VERSION).optional(),
  type: z.enum(["single", "blueprint"]).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  expectedVersion: z.number().int().positive(),
  skills: z.array(skillSchema).optional(),
  mcpServers: mcpServersSchema.optional(),
  runtimeId: z.string().min(1).optional(),
  rag: nodeRagSchema.optional(),
  rootNodeId: z.string().optional(),
  nodes: z.array(agentNodeSchema).optional(),
  edges: z.array(agentEdgeSchema).optional(),
  executionPolicy: executionPolicySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const executeAgentTaskSchema = z.object({
  task: z.string().min(1),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  dryRun: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  sandboxMode: z.enum(["workspace-write", "read-only", "danger-full-access"]).optional(),
  attachments: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["file", "folder", "image"]),
    name: z.string().min(1),
    path: z.string().min(1),
    mimeType: z.string().optional(),
    size: z.number().nonnegative().optional(),
    childCount: z.number().int().nonnegative().optional(),
  }).strict()).max(200).default([]),
}).strict();

const workspaceRagPlanSchema = z.object({
  domainRefs: z.array(z.string().min(1)).default([]),
  topicRefs: z.array(z.string().min(1)).default([]),
}).strict();

const workspaceRagSearchSchema = workspaceRagPlanSchema.extend({
  query: z.string().min(1),
  topN: z.number().int().positive().default(4),
}).strict();

const workspaceRagDocumentsSchema = workspaceRagPlanSchema.extend({
  suffixes: z.array(z.string().min(1)).default([]),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
}).strict();

const retryNodeRunSchema = z.object({
  nodeRunId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
}).strict();

const resumeNodeRunSchema = z.object({
  nodeRunId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  output: z.unknown().optional(),
}).strict();

const expectedArtifactSchema = z.object({
  type: z.string().min(1),
  count: z.number().int().positive().optional(),
  description: z.string().optional(),
}).strict();

const contextReferenceSchema = z.object({
  ref: z.string().regex(/^ctx:\/\//),
  title: z.string().min(1),
  summary: z.string().default(""),
  reason: z.string().default(""),
}).strict();

const graphNodeDispatchInputSchema = z.object({
  nodeTask: z.string().min(1),
  relevantContext: z.unknown().optional(),
  contextRefs: z.array(contextReferenceSchema).default([]),
  requirements: z.array(z.string().min(1)).default([]),
  expectedArtifacts: z.array(expectedArtifactSchema).default([]),
}).strict();

const dispatchGraphNodeSchema = z.object({
  nodeId: z.string().min(1),
  input: graphNodeDispatchInputSchema,
  parentNodeRunId: z.string().min(1).optional(),
  reason: z.string().optional(),
}).strict();

const requestUserSchema = z.object({
  question: z.string().min(1),
  reason: z.string().optional(),
}).strict();

const resolveGraphRunSchema = z.object({
  output: z.unknown().optional(),
  reason: z.string().optional(),
}).strict();

const appendTraceSchema = z.object({
  type: z.string().min(1),
  payload: z.unknown().optional(),
  nodeRunId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
}).strict();

export class AgentOrchestrator {
  constructor({
    client,
    ragProvider,
    resourceManager,
    runtimeRegistry,
    contextStore,
    settings = {},
    databasePath,
    stateStore,
  }) {
    this.client = client;
    this.ragProvider = ragProvider || client;
    this.resourceManager = resourceManager;
    this.runtimeRegistry = runtimeRegistry || new RuntimeRegistry({ settings });
    this.settings = settings;
    const resolvedDatabasePath = databasePath || settings.metadataDbPath || config.metadataDbPath;
    this.stateStore = stateStore || new SqliteStateStore({
      databasePath: resolvedDatabasePath,
      resourceRootPath: settings.resourceRootPath || path.dirname(resolvedDatabasePath),
    });
    this.contextStore = contextStore || new ContextStore({ repository: this.stateStore.repository });
    this.storeLock = Promise.resolve();
    this.graphRunEventHandlers = new Map();
    this.graphRunExecutions = new Map();
  }

  async listWorkspaces() {
    const store = await this.readStore();
    return { workspaces: store.workspaces };
  }

  async ensureDefaultWorkspace() {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const existing = store.workspaces.find((workspace) => workspace.metadata?.isDefault === true);
      if (existing) {
        if (typeof existing.hippoMcpEnabled === "boolean") return { workspace: existing, created: false };
        const workspace = { ...existing, hippoMcpEnabled: true, updatedAt: new Date().toISOString() };
        store.workspaces[store.workspaces.findIndex((item) => item.id === existing.id)] = workspace;
        await this.writeStore(store);
        return { workspace, created: false };
      }

      const namedDefault = store.workspaces.find((workspace) => workspace.name === "默认工作区");
      if (namedDefault) {
        const workspace = {
          ...namedDefault,
          hippoMcpEnabled: typeof namedDefault.hippoMcpEnabled === "boolean" ? namedDefault.hippoMcpEnabled : true,
          metadata: { ...(namedDefault.metadata || {}), isDefault: true },
          updatedAt: new Date().toISOString(),
        };
        store.workspaces[store.workspaces.findIndex((item) => item.id === namedDefault.id)] = workspace;
        await this.writeStore(store);
        return { workspace, created: false };
      }

      const now = new Date().toISOString();
      const workspaceId = randomUUID();
      const workspaceDirectory = this.resourceManager
        ? await this.resourceManager.createWorkspace({ workspaceId, workspaceName: "默认工作区" })
        : {};
      const workspace = {
        id: workspaceId,
        name: "默认工作区",
        description: "用于从 Hippo 首页发起的日常任务。",
        hippoMcpEnabled: true,
        agentIds: [],
        knowledgeDomainRefs: [],
        knowledgeTopicRefs: [],
        localWorkspacePath: workspaceDirectory.workspacePath || "",
        localWorkspaceFolderName: workspaceDirectory.workspaceFolderName || "",
        metadata: { isDefault: true },
        createdAt: now,
        updatedAt: now,
      };
      store.workspaces.push(workspace);
      await this.writeStore(store);
      return { workspace, created: true };
    });
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

  getAgentSchema() {
    return {
      schemaId: AGENT_BLUEPRINT_SCHEMA_ID,
      schemaVersion: AGENT_BLUEPRINT_SCHEMA_VERSION,
      schema: getAgentBlueprintSchema(),
    };
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
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const now = new Date().toISOString();
      const agent = normalizeAgent({
        id: randomUUID(),
        version: 1,
        ...payload,
        createdAt: now,
        updatedAt: now,
      });
      validateAgentPrototype(agent);
      store.agents.push(agent);
      await this.writeStore(store);
      return { agent };
    });
  }

  async updateAgent(id, input) {
    const payload = updateAgentSchema.parse(input);
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const index = store.agents.findIndex((item) => item.id === id);
      if (index === -1) throw new AgentOrchestratorError(`Agent ${id} was not found.`, 404);
      const current = store.agents[index];
      if (payload.expectedVersion !== current.version) {
        throw new AgentOrchestratorError(
          `Agent ${id} has changed since version ${payload.expectedVersion}.`,
          409,
          { expectedVersion: payload.expectedVersion, actualVersion: current.version }
        );
      }
      const candidate = {
        ...current,
        ...definedOnly({
          $schema: payload.$schema,
          schemaVersion: payload.schemaVersion,
          type: payload.type,
          name: payload.name,
          description: payload.description,
          systemPrompt: payload.systemPrompt,
          skills: payload.skills,
          mcpServers: payload.mcpServers,
          runtimeId: payload.runtimeId,
          rag: payload.rag,
          rootNodeId: payload.rootNodeId,
          nodes: payload.nodes,
          edges: payload.edges,
          executionPolicy: payload.executionPolicy,
          metadata: payload.metadata,
        }),
      };
      const updated = normalizeAgent({
        ...candidate,
        version: Number(current.version || 1) + 1,
        updatedAt: new Date().toISOString(),
      });
      validateAgentPrototype(updated);
      store.agents[index] = updated;
      await this.writeStore(store);
      return { agent: updated };
    });
  }

  async deleteAgent(id) {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      if (!store.agents.some((item) => item.id === id)) {
        throw new AgentOrchestratorError(`Agent ${id} was not found.`, 404);
      }
      const workspaceIds = store.workspaces
        .filter((workspace) => workspace.agentIds?.includes(id))
        .map((workspace) => workspace.id);
      if (workspaceIds.length) {
        throw new AgentOrchestratorError(
          `Agent ${id} is still referenced by a workspace.`,
          409,
          { workspaceIds }
        );
      }
      store.agents = store.agents.filter((item) => item.id !== id);
      await this.writeStore(store);
      return { deleted: true, id };
    });
  }

  async getWorkspace(id) {
    const store = await this.readStore();
    const workspace = store.workspaces.find((item) => item.id === id);
    if (!workspace) throw new AgentOrchestratorError(`Workspace ${id} was not found.`, 404);
    return { workspace };
  }

  async listConversations(workspaceId, options = {}) {
    const store = await this.readStore();
    this.findWorkspace(store, workspaceId);
    const conversations = store.conversations
      .filter((conversation) => conversation.workspaceId === workspaceId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .map((conversation) => options.summary ? summarizeConversation(conversation) : conversation);
    return { conversations };
  }

  async getConversation(workspaceId, conversationId) {
    const store = await this.readStore();
    this.findWorkspace(store, workspaceId);
    const conversation = store.conversations.find((item) =>
      item.workspaceId === workspaceId && item.id === conversationId
    );
    if (!conversation) {
      throw new AgentOrchestratorError(`Conversation ${conversationId} was not found.`, 404);
    }
    return { conversation };
  }

  async createConversation(workspaceId, input = {}) {
    const payload = createConversationSchema.parse(input);
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      this.findWorkspace(store, workspaceId);
      const now = new Date().toISOString();
      const conversation = {
        id: payload.id || randomUUID(),
        type: "root",
        workspaceId,
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
    });
  }

  async updateConversation(workspaceId, conversationId, input = {}) {
    const payload = updateConversationSchema.parse(input);
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      this.findWorkspace(store, workspaceId);
      const index = store.conversations.findIndex((item) =>
        item.workspaceId === workspaceId && item.id === conversationId
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
    });
  }

  async branchConversation(workspaceId, conversationId, input = {}) {
    const payload = branchConversationSchema.parse(input);
    const branched = await this.withStoreLock(async () => {
      const store = await this.readStore();
      this.findWorkspace(store, workspaceId);
      const index = store.conversations.findIndex((item) =>
        item.workspaceId === workspaceId && item.id === conversationId
      );
      if (index === -1) {
        throw new AgentOrchestratorError(`Conversation ${conversationId} was not found.`, 404);
      }
      const current = store.conversations[index];
      const target = current.messages?.[payload.messageIndex];
      if (!target || target.role !== "user") {
        throw new AgentOrchestratorError("Only an existing user message can be edited and resent.", 400);
      }

      const messages = normalizeMessages(current.messages.slice(0, payload.messageIndex));
      const retainedRunIds = new Set(messages.map((message) => message.runId).filter(Boolean));
      const removedRuns = store.agentRuns.filter((run) =>
        run.workspaceId === workspaceId
        && run.rootSessionId === conversationId
        && !retainedRunIds.has(run.id)
      );
      for (const run of removedRuns) {
        const runtimeRunIds = new Set([
          run.rootCoordinator?.runtimeRunId,
          ...Object.values(run.nodeRuns || {}).map((nodeRun) => nodeRun.runtimeRunId),
        ].filter(Boolean));
        for (const runtimeRunId of runtimeRunIds) this.cancelRuntimeRun(runtimeRunId);
      }
      store.agentRuns = store.agentRuns.filter((run) => !removedRuns.includes(run));

      const now = new Date().toISOString();
      const conversation = normalizeConversation({
        ...current,
        title: deriveConversationTitle(messages) || "新对话",
        messages,
        runtimeSessions: {},
        runIds: [...retainedRunIds],
        metadata: { ...(current.metadata || {}), runtimeSessions: {} },
        updatedAt: now,
      });
      store.conversations[index] = conversation;
      await this.writeStore(store);
      const runtimeSessions = [
        ...Object.values(normalizeRuntimeSessions(current.runtimeSessions)),
        ...removedRuns.flatMap((run) => [
          run.rootCoordinator?.runtimeSession,
          ...Object.values(run.nodeRuns || {}).map((nodeRun) => nodeRun.runtimeSession),
        ]),
      ].filter((session) => session?.sessionId);
      return { conversation, runtimeSessions };
    });
    await Promise.allSettled(
      dedupeBy(branched.runtimeSessions, (session) => `${session.provider || "codex"}:${session.sessionId}`)
        .map((session) => this.runtimeRegistry.deleteSession?.(session) || Promise.resolve({ deleted: false }))
    );
    return { conversation: branched.conversation };
  }

  async deleteConversation(workspaceId, conversationId) {
    const cleanup = await this.withStoreLock(async () => {
      const store = await this.readStore();
      const workspace = this.findWorkspace(store, workspaceId);
      const deletedConversation = store.conversations.find((item) =>
        item.workspaceId === workspaceId && item.id === conversationId
      );
      const next = store.conversations.filter((item) =>
        !(item.workspaceId === workspaceId && item.id === conversationId)
      );
      if (next.length === store.conversations.length) {
        throw new AgentOrchestratorError(`Conversation ${conversationId} was not found.`, 404);
      }
      const deletedRuns = store.agentRuns.filter((run) =>
        run.workspaceId === workspaceId && run.rootSessionId === conversationId
      );
      for (const run of deletedRuns) {
        const runtimeRunIds = new Set([
          run.rootCoordinator?.runtimeRunId,
          ...Object.values(run.nodeRuns || {}).map((nodeRun) => nodeRun.runtimeRunId),
        ].filter(Boolean));
        for (const runtimeRunId of runtimeRunIds) this.cancelRuntimeRun(runtimeRunId);
      }
      store.conversations = next;
      store.agentRuns = store.agentRuns.filter((run) =>
        !(run.workspaceId === workspaceId && run.rootSessionId === conversationId)
      );
      await this.writeStore(store);
      const runtimeSessions = [
        ...Object.values(normalizeRuntimeSessions(deletedConversation.runtimeSessions)),
        ...deletedRuns.flatMap((run) => [
          run.rootCoordinator?.runtimeSession,
          ...Object.values(run.nodeRuns || {}).map((nodeRun) => nodeRun.runtimeSession),
        ]),
      ].filter((session) => session?.sessionId);
      return { workspace, deletedConversation, remainingConversations: next, runtimeSessions };
    });
    await Promise.allSettled([
      removeUnreferencedAttachmentBatches(cleanup.workspace, cleanup.deletedConversation, cleanup.remainingConversations),
      this.contextStore.deleteSession({
        workspacePath: cleanup.workspace.localWorkspacePath,
        sessionId: conversationId,
      }),
      ...dedupeBy(cleanup.runtimeSessions, (session) => `${session.provider || "codex"}:${session.sessionId}`)
        .map((session) => this.runtimeRegistry.deleteSession?.(session) || Promise.resolve({ deleted: false })),
    ]);
    return { deleted: true, id: conversationId };
  }

  async listAgentRuns(workspaceId, filters = {}) {
    const store = await this.readStore();
    this.findWorkspace(store, workspaceId);
    const runs = store.agentRuns
      .filter((run) => run.workspaceId === workspaceId)
      .filter((run) => !filters.rootSessionId || run.rootSessionId === filters.rootSessionId)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .map((run) => filters.summary ? summarizeAgentRunForList(run) : run);
    return { runs };
  }

  async getAgentRun(workspaceId, runId) {
    const store = await this.readStore();
    this.findWorkspace(store, workspaceId);
    const run = store.agentRuns.find((item) => item.workspaceId === workspaceId && item.id === runId);
    if (!run) throw new AgentOrchestratorError(`Agent run ${runId} was not found.`, 404);
    return { run };
  }

  async reconcileInterruptedRuns() {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const now = new Date().toISOString();
      let interruptedRuns = 0;
      let restoredRuns = 0;
      let storeChanged = false;
      store.agentRuns = store.agentRuns.map((storedRun) => {
        const run = normalizeAgentRun(storedRun);
        const resultApprovalNode = findDurableResultApprovalNode(run);
        if (run.status === "failed" && run.error?.code === "service_restarted" && resultApprovalNode) {
          run.status = "waiting_approval";
          run.error = undefined;
          run.updatedAt = now;
          run.rootCoordinator.status = "ready";
          run.rootCoordinator.runtimeRunId = "";
          run.rootCoordinator.updatedAt = now;
          resultApprovalNode.status = "waiting_approval";
          resultApprovalNode.error = undefined;
          resultApprovalNode.runtimeRunId = "";
          resultApprovalNode.updatedAt = now;
          resultApprovalNode.trace.push(createTrace("node_run_approval_restored", { reason: "service_restarted" }, now));
          run.trace.push(createTrace("agent_run_approval_restored", { reason: "service_restarted" }, now));
          restoredRuns += 1;
          storeChanged = true;
          return run;
        }
        if (run.status === "waiting_approval" && resultApprovalNode) {
          if (resultApprovalNode.runtimeRunId || run.rootCoordinator?.runtimeRunId) {
            resultApprovalNode.runtimeRunId = "";
            if (run.rootCoordinator) run.rootCoordinator.runtimeRunId = "";
            storeChanged = true;
          }
          return run;
        }
        const interruptedManagedRun = run.managed && ["pending", "waiting_approval"].includes(run.status);
        if (!["running", "coordinating"].includes(run.status) && !interruptedManagedRun) return run;
        interruptedRuns += 1;
        storeChanged = true;
        run.status = "failed";
        run.error = {
          code: "service_restarted",
          message: "Hippo service restarted while this run was active.",
        };
        run.updatedAt = now;
        if (run.rootCoordinator && ["pending", "ready", "running", "waiting_approval"].includes(run.rootCoordinator.status)) {
          run.rootCoordinator.status = "failed";
          run.rootCoordinator.runtimeRunId = "";
          run.rootCoordinator.updatedAt = now;
        }
        for (const nodeRun of Object.values(run.nodeRuns || {})) {
          if (!["pending", "ready", "running", "waiting_approval"].includes(nodeRun.status)) continue;
          nodeRun.status = "failed";
          nodeRun.error = run.error;
          nodeRun.runtimeRunId = "";
          nodeRun.updatedAt = now;
          nodeRun.trace.push(createTrace("node_run_interrupted", { reason: "service_restarted" }, now));
        }
        run.trace.push(createTrace("agent_run_interrupted", { reason: "service_restarted" }, now));
        return run;
      });
      if (storeChanged) await this.writeStore(store);
      return { interruptedRuns, restoredRuns };
    });
  }

  async getNodeRun(workspaceId, runId, nodeRunId) {
    const { run } = await this.getAgentRun(workspaceId, runId);
    const nodeRun = run.nodeRuns?.[nodeRunId] || Object.values(run.nodeRuns || {}).find((item) => item.nodeId === nodeRunId);
    if (!nodeRun) throw new AgentOrchestratorError(`Node run ${nodeRunId} was not found.`, 404);
    return { run, nodeRun };
  }

  async listAgentRunTrace(workspaceId, runId, input = {}) {
    const { run } = await this.getAgentRun(workspaceId, runId);
    if (input.nodeRunId || input.nodeId) {
      const nodeRun = input.nodeRunId
        ? run.nodeRuns?.[input.nodeRunId]
        : Object.values(run.nodeRuns || {}).find((item) => item.nodeId === input.nodeId);
      if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
      return { trace: nodeRun.trace || [], run, nodeRun };
    }
    return { trace: run.trace || [], run };
  }

  async appendAgentRunTraceEvent(workspaceId, runId, input = {}) {
    const payload = appendTraceSchema.parse(input);
    return this.updateAgentRun(workspaceId, runId, (run, now) => {
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
    if (agent?.type !== "blueprint") {
      throw new AgentOrchestratorError("Graph runs require a Blueprint agent.", 400);
    }
    const agentRun = await this.createAgentRun(project, rootSession, agent, request, {
      input: await this.prepareBlueprintRunInput(project, payload, rootSession, request.runId),
      retrieval,
      managed: false,
    });
    return { workspace: project, agent, request, retrieval, agentRun };
  }

  async advanceGraphRun(workspaceId, runId, onEvent) {
    const { workspace: project } = await this.getWorkspace(workspaceId);
    const { run } = await this.getAgentRun(workspaceId, runId);
    if (run.agentSnapshot?.type !== "blueprint") {
      throw new AgentOrchestratorError("Only Blueprint agent runs can be advanced.", 400);
    }
    const request = run.request || {
      runtimeId: run.agentSnapshot.runtimeId || config.defaultRuntimeId,
      runId: run.id,
      workspaceId,
      mode: "chat",
      message: run.input?.task || "",
      sessionId: run.rootSessionId,
    };
    const updated = await this.coordinateGraphRun(project, run.agentSnapshot, request, runId, onEvent);
    return { workspace: project, run: updated.run };
  }

  async dispatchGraphNode(workspaceId, runId, input = {}, onEvent) {
    const eventHandler = onEvent || this.graphRunEventHandlers.get(runId);
    const payload = dispatchGraphNodeSchema.parse(input);
    const { workspace: project } = await this.getWorkspace(workspaceId);
    const { run } = await this.getAgentRun(workspaceId, runId);
    if (run.agentSnapshot?.type !== "blueprint") {
      throw new AgentOrchestratorError("Only graph runs can dispatch nodes.", 400);
    }
    if (payload.nodeId === run.agentSnapshot.rootNodeId) {
      throw new AgentOrchestratorError("Root is the coordinator and cannot be dispatched as a worker node.", 400);
    }
    const nodeDef = run.agentSnapshot.nodes.find((node) => node.id === payload.nodeId);
    if (!nodeDef) throw new AgentOrchestratorError(`Graph node ${payload.nodeId} was not found.`, 404);
    let nodeRun;
    await this.updateAgentRun(workspaceId, runId, (current, updatedAt) => {
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
      workspaceId,
      mode: "chat",
      sessionId: run.rootSessionId,
      runtimeOptions: {},
    };
    const result = await this.executeBlueprintNode(project, run.agentSnapshot, request, runId, nodeRun.id, eventHandler)
      .catch(() => undefined);
    return { workspace: project, ...(await this.getAgentRun(workspaceId, runId)), nodeRunId: nodeRun.id, result };
  }

  async retryNodeRun(workspaceId, runId, input = {}) {
    const payload = retryNodeRunSchema.parse(input);
    const { run } = await this.getAgentRun(workspaceId, runId);
    const nodeRun = payload.nodeRunId
      ? run.nodeRuns?.[payload.nodeRunId]
      : findLatestNodeRunByPrototype(run, payload.nodeId);
    if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
    return this.dispatchGraphNode(workspaceId, runId, {
      nodeId: nodeRun.prototypeNodeId || nodeRun.nodeId,
      input: {
        nodeTask: nodeRun.input?.nodeTask,
        relevantContext: nodeRun.input?.relevantContext,
        contextRefs: nodeRun.input?.contextRefs || [],
        requirements: nodeRun.input?.requirements || [],
        expectedArtifacts: nodeRun.input?.expectedArtifacts || [],
      },
      parentNodeRunId: nodeRun.id,
      reason: "Root coordinator requested a retry.",
    });
  }

  async approveNodeRun(workspaceId, runId, input = {}) {
    const payload = resumeNodeRunSchema.parse(input);
    const { run } = await this.getAgentRun(workspaceId, runId);
    const nodeRun = payload.nodeRunId
      ? run.nodeRuns?.[payload.nodeRunId]
      : findLatestNodeRunByPrototype(run, payload.nodeId);
    if (!nodeRun) throw new AgentOrchestratorError("Node run was not found.", 404);
    if (nodeRun.status !== "waiting_approval") {
      throw new AgentOrchestratorError("Only node runs waiting for approval can be resumed.", 400);
    }
    return this.updateAgentRun(workspaceId, runId, (current, now) => {
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
  }

  async resumeNodeRun(workspaceId, runId, input = {}, onEvent) {
    await this.approveNodeRun(workspaceId, runId, input);
    return this.advanceGraphRun(workspaceId, runId, onEvent);
  }

  async requestGraphRunUser(workspaceId, runId, input = {}) {
    const payload = requestUserSchema.parse(input);
    return this.updateAgentRun(workspaceId, runId, (run, now) => {
      assertGraphRunMutable(run);
      run.status = "waiting_user";
      run.output = { kind: "user_request", question: payload.question, reason: payload.reason || "" };
      run.rootCoordinator.status = "waiting_user";
      run.rootCoordinator.updatedAt = now;
      run.trace.push(createTrace("graph_run_user_requested", payload, now));
      return run;
    });
  }

  async resumeGraphRunWithUserInput(workspaceId, runId, input = {}, onEvent) {
    const userInput = input.input ?? input.message ?? input.text;
    if (userInput === undefined || userInput === "") {
      throw new AgentOrchestratorError("A user response is required to resume the graph run.", 400);
    }
    const { workspace: project } = await this.getWorkspace(workspaceId);
    const { run } = await this.getAgentRun(workspaceId, runId);
    if (run.status !== "waiting_user") {
      throw new AgentOrchestratorError("Only graph runs waiting for user input can be resumed.", 409);
    }
    await this.updateAgentRun(workspaceId, runId, (current, now) => {
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
      workspaceId,
      sessionId: run.rootSessionId,
      runtimeOptions: {},
    };
    const completedRun = await this.coordinateGraphRun(project, run.agentSnapshot, request, runId, onEvent);
    const result = {
      runtimeId: request.runtimeId,
      runId,
      text: completedRun.run.status === "waiting_user"
        ? completedRun.run.output?.question || "RootAgent 正在等待用户输入。"
        : stringifyBlueprintOutput(completedRun.run.output),
      output: completedRun.run.output,
    };
    onEvent?.({ type: "done", workspace: project, agent: run.agentSnapshot, request, result, agentRun: completedRun.run });
    return { workspace: project, agent: run.agentSnapshot, request, result, agentRun: completedRun.run, run: completedRun.run };
  }

  async completeGraphRun(workspaceId, runId, input = {}) {
    const payload = resolveGraphRunSchema.parse(input);
    const { workspace } = await this.getWorkspace(workspaceId);
    const { run } = await this.getAgentRun(workspaceId, runId);
    assertGraphRunMutable(run);
    const rawOutput = payload.output === undefined ? collectBlueprintOutput(run) : payload.output;
    const output = await this.attachBlueprintDisplayText(workspace, run, rawOutput);
    return this.completeBlueprintRun(workspaceId, runId, {
      status: "completed",
      output,
    });
  }

  async attachBlueprintDisplayText(workspace, run, output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return output;
    const displayText = await buildBlueprintDisplayText({
      workspace,
      run,
      output,
      contextStore: this.contextStore,
    });
    return displayText ? { ...output, displayText } : output;
  }

  async failGraphRun(workspaceId, runId, input = {}) {
    const payload = resolveGraphRunSchema.parse(input);
    assertGraphRunMutable((await this.getAgentRun(workspaceId, runId)).run);
    return this.completeBlueprintRun(workspaceId, runId, {
      status: "failed",
      output: payload.output,
      error: { message: payload.reason || "Root coordinator marked the run as failed." },
    });
  }

  async createWorkspace(input) {
    const payload = createWorkspaceSchema.parse(input);
    const now = new Date().toISOString();
    const workspaceId = randomUUID();
    const workspaceDirectory = this.resourceManager
      ? await this.resourceManager.createWorkspace({ workspaceId, workspaceName: payload.name })
      : {};
    const knowledgeTopicRefs = normalizeTopicRefs(payload.knowledgeTopicRefs, payload.knowledgeDomainRefs);
    const knowledgeDomainRefs = normalizeDomainRefs(payload.knowledgeDomainRefs, knowledgeTopicRefs);
    const workspace = {
      id: workspaceId,
      name: payload.name,
      description: payload.description || "",
      hippoMcpEnabled: payload.hippoMcpEnabled,
      agentIds: dedupe(payload.agentIds),
      knowledgeDomainRefs,
      knowledgeTopicRefs,
      localWorkspacePath: workspaceDirectory.workspacePath || "",
      localWorkspaceFolderName: workspaceDirectory.workspaceFolderName || "",
      metadata: payload.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    return this.withStoreLock(async () => {
      const store = await this.readStore();
      store.workspaces.push(workspace);
      await this.writeStore(store);
      return { workspace };
    });
  }

  async updateWorkspace(id, input) {
    const payload = updateWorkspaceSchema.parse(input);
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const index = store.workspaces.findIndex((item) => item.id === id);
      if (index === -1) throw new AgentOrchestratorError(`Workspace ${id} was not found.`, 404);

      const current = store.workspaces[index];
      const domainsChanged = payload.knowledgeDomainRefs !== undefined;
      const topicsChanged = payload.knowledgeTopicRefs !== undefined;
      const nextDomainRefs = domainsChanged
        ? normalizeDomainRefs(payload.knowledgeDomainRefs)
        : normalizeDomainRefs(current.knowledgeDomainRefs || []);
      const nextTopicRefs = nextDomainRefs.length
        ? normalizeTopicRefs(
            topicsChanged ? payload.knowledgeTopicRefs : current.knowledgeTopicRefs || [],
            nextDomainRefs
          )
        : [];
      const updated = {
        ...current,
        ...definedOnly({
          name: payload.name,
          description: payload.description,
          hippoMcpEnabled: payload.hippoMcpEnabled,
          agentIds: payload.agentIds ? dedupe(payload.agentIds) : undefined,
          knowledgeDomainRefs: domainsChanged ? nextDomainRefs : undefined,
          knowledgeTopicRefs: domainsChanged || topicsChanged ? nextTopicRefs : undefined,
          metadata: payload.metadata,
        }),
        updatedAt: new Date().toISOString(),
      };

      store.workspaces[index] = updated;
      await this.writeStore(store);
      return { workspace: updated };
    });
  }

  async deleteWorkspace(id) {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const next = store.workspaces.filter((item) => item.id !== id);
      if (next.length === store.workspaces.length) {
        throw new AgentOrchestratorError(`Workspace ${id} was not found.`, 404);
      }
      store.workspaces = next;
      const deletedConversations = store.conversations.filter((conversation) => conversation.workspaceId === id).length;
      const deletedRuns = store.agentRuns.filter((run) => run.workspaceId === id).length;
      store.conversations = store.conversations.filter((conversation) => conversation.workspaceId !== id);
      store.agentRuns = store.agentRuns.filter((run) => run.workspaceId !== id);
      await this.writeStore(store);
      return { deleted: true, workspaceId: id, deletedConversations, deletedRuns };
    });
  }

  async executeAgentTask(id, input) {
    const prepared = await this.prepareAgentTask(id, input);
    const { payload, project, agent, request, retrieval, rootSession } = prepared;
    if (agent?.type === "blueprint") {
      return this.executeBlueprintAgentTask(prepared);
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
      return { workspace: project, agent, request, retrieval, dryRun: true, agentRun: completedRun.run };
    }

    const runtime = this.runtimeRegistry.getRuntime(request.runtimeId);
    await this.markAgentRunRunning(project.id, agentRun.id, request.runId);
    try {
      const result = await runtime.execute({
        project,
        agent,
        prompt: request.message,
        rootSession,
        runId: request.runId,
        runtimeOptions: request.runtimeOptions,
        attachments: request.attachments,
      });
      await this.persistRuntimeSession(project.id, payload.sessionId, result.runtimeSession, agent?.id, result.runId);
      const completedRun = await this.completeAgentRun(project.id, agentRun.id, {
        status: "completed",
        output: result,
        nodeOutput: result,
        runtimeSession: result.runtimeSession,
        trace: result.events || [],
      });

      return { workspace: project, agent, request, retrieval, result, agentRun: completedRun.run };
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
    if (agent?.type === "blueprint") {
      return this.executeBlueprintAgentTask(prepared, onEvent);
    }
    const agentRun = await this.createAgentRun(project, rootSession, agent, request, {
      input: { task: payload.task, context: payload.context || {} },
      retrieval,
    });

    onEvent?.({ type: "prepared", workspace: project, agent, request, retrieval, agentRun });

    if (payload.dryRun) {
      const result = { dryRun: true, text: `已生成编排请求：\n\n${request.message}` };
      const completedRun = await this.completeAgentRun(project.id, agentRun.id, {
        status: "completed",
        output: result,
        nodeOutput: result,
      });
      onEvent?.({ type: "done", workspace: project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { workspace: project, agent, request, retrieval, result, agentRun: completedRun.run };
    }

    const runtime = this.runtimeRegistry.getRuntime(request.runtimeId);
    await this.markAgentRunRunning(project.id, agentRun.id, request.runId);
    const tracedEvent = async (event) => {
      if (event?.type === "runtime_request") {
        await this.updateAgentRun(project.id, agentRun.id, (run, now) => {
          run.status = "waiting_approval";
          const nodeRun = getPrimaryNodeRun(run);
          nodeRun.status = "waiting_approval";
          nodeRun.updatedAt = now;
          const trace = createTrace("runtime_request", event, now);
          run.trace.push(trace);
          nodeRun.trace.push(trace);
          return run;
        });
        onEvent?.(event);
        return;
      } else if (event?.type === "runtime_request_resolved") {
        await this.updateAgentRun(project.id, agentRun.id, (run, now) => {
          run.status = "running";
          const nodeRun = getPrimaryNodeRun(run);
          nodeRun.status = "running";
          nodeRun.updatedAt = now;
          const trace = createTrace("runtime_request_resolved", event, now);
          run.trace.push(trace);
          nodeRun.trace.push(trace);
          return run;
        });
        onEvent?.(event);
        return;
      }
      onEvent?.(event);
      if (event?.type === "runtime_event") {
        if (event.eventType === "runtime_session_started" && event.sessionId) {
          await this.persistRuntimeSession(project.id, payload.sessionId, {
            provider: event.runtimeId || request.runtimeId,
            sessionId: event.sessionId,
            workspacePath: project.localWorkspacePath || "",
            hippoSessionId: payload.sessionId || "",
            status: "active",
            runtimeOptions: request.runtimeOptions,
            updatedAt: new Date().toISOString(),
          }, agent?.id, request.runId);
        }
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
            runId: request.runId,
            runtimeOptions: request.runtimeOptions,
            attachments: request.attachments,
            onEvent: tracedEvent,
          })
        : await runtime.execute({
            project,
            agent,
            prompt: request.message,
            rootSession,
            runId: request.runId,
            runtimeOptions: request.runtimeOptions,
            attachments: request.attachments,
          });

      await this.persistRuntimeSession(project.id, payload.sessionId, result.runtimeSession, agent?.id, result.runId);
      const completedRun = await this.completeAgentRun(project.id, agentRun.id, {
        status: "completed",
        output: result,
        nodeOutput: result,
        runtimeSession: result.runtimeSession,
        trace: [],
      });
      onEvent?.({ type: "done", workspace: project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { workspace: project, agent, request, retrieval, result, agentRun: completedRun.run };
    } catch (error) {
      await this.completeAgentRun(project.id, agentRun.id, {
        status: error.status === 499 || error.details?.cancelled ? "cancelled" : "failed",
        error: serializeError(error),
      }).catch(() => {});
      throw error;
    }
  }

  async executeBlueprintAgentTask(prepared, onEvent) {
    const { payload, project, agent, request, retrieval, rootSession } = prepared;
    if (rootSession?.id) {
      const waitingRun = (await this.listAgentRuns(project.id, { rootSessionId: rootSession.id })).runs
        .find((run) => run.agentId === agent.id && run.status === "waiting_user");
      if (waitingRun) {
        return this.resumeGraphRunWithUserInput(project.id, waitingRun.id, { input: payload.task }, onEvent);
      }
    }
    const agentRun = await this.createAgentRun(project, rootSession, agent, request, {
      input: await this.prepareBlueprintRunInput(project, payload, rootSession, request.runId),
      retrieval,
    });
    onEvent?.({ type: "prepared", workspace: project, agent, request, retrieval, agentRun });

    if (payload.dryRun) {
      const completedRun = await this.completeBlueprintDryRun(project.id, agentRun.id, request);
      const result = {
        dryRun: true,
        text: `已生成蓝图运行图：${Object.keys(completedRun.run.nodeRuns || {}).length} 个节点。`,
      };
      onEvent?.({ type: "done", workspace: project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { workspace: project, agent, request, retrieval, result, dryRun: true, agentRun: completedRun.run };
    }

    try {
      const completedRun = await this.coordinateGraphRun(project, agent, request, agentRun.id, onEvent);
      const result = {
        runtimeId: request.runtimeId,
        runId: agentRun.id,
        text: completedRun.run.status === "waiting_user"
          ? completedRun.run.output?.question || "RootAgent 正在等待用户输入。"
          : stringifyBlueprintOutput(completedRun.run.output),
        output: completedRun.run.output,
      };
      onEvent?.({ type: "done", workspace: project, agent, request, retrieval, result, agentRun: completedRun.run });
      return { workspace: project, agent, request, retrieval, result, agentRun: completedRun.run };
    } catch (error) {
      const status = error.status === 499 || error.details?.cancelled ? "cancelled" : "failed";
      await this.completeBlueprintRun(project.id, agentRun.id, {
        status,
        error: serializeError(error),
      }).catch(() => {});
      throw error;
    }
  }

  async prepareAgentTask(id, input) {
    const payload = executeAgentTaskSchema.parse(input);
    const { workspace: project } = await this.getWorkspace(id);
    const rootSession = payload.sessionId
      ? await this.ensureExecutionConversation(id, payload.sessionId, payload)
      : undefined;
    const agent = payload.agentId ? (await this.getAgent(payload.agentId)).agent : undefined;
    if (agent && !project.agentIds?.includes(agent.id)) {
      throw new AgentOrchestratorError(
        `智能体「${agent.name || agent.id}」未在工作区「${project.name || project.id}」中启用，请先在工作区设置中添加。`,
        403
      );
    }

    const rag = normalizeNodeRag(agent?.rag);
    const retrieval = {
      skipped: true,
      reason: rag.enabled ? "model-tool-controlled" : "rag-disabled",
    };
    const baseRuntimeOptions = project.hippoMcpEnabled
      ? withHippoSystemToolRuntimeOptions(buildRuntimeOptions(payload))
      : buildRuntimeOptions(payload);
    const runtimeOptions = agent?.type === "blueprint"
      ? baseRuntimeOptions
      : withRagToolRuntimeOptions(baseRuntimeOptions, project.id, rag);
    const attachments = await resolveWorkspaceAttachments(project, payload.attachments);
    const message = buildAgentMessage(project, agent, payload.task, payload.context, {
      runtimeId: agent?.runtimeId || this.settings.defaultRuntimeId || config.defaultRuntimeId,
      rag,
      runtimeOptions,
      attachments,
    });
    const request = {
      runtimeId: agent?.runtimeId || this.settings.defaultRuntimeId || config.defaultRuntimeId,
      runId: payload.runId || randomUUID(),
      workspaceId: project.id,
      mode: "chat",
      message,
      sessionId: payload.sessionId,
      runtimeOptions,
      attachments,
    };
    return { payload, project, agent, request, retrieval, rootSession };
  }

  async prepareBlueprintRunInput(project, payload, rootSession, currentRunId) {
    if (!rootSession?.id) return { task: payload.task, context: payload.context || {}, conversationContext: [] };
    const messages = buildConversationHistory(rootSession, currentRunId);
    const conversationContext = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const identity = [message.runId, message.createdAt, message.role, index, message.text].filter(Boolean).join("\n");
      const contextId = `message-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
      const title = `${message.role === "user" ? "用户消息" : "助手消息"}${message.createdAt ? ` · ${message.createdAt}` : ""}`;
      const summary = summarizeContextText(message.text);
      const written = await this.contextStore.write({
        workspacePath: project.localWorkspacePath,
        sessionId: rootSession.id,
        contextId,
        title,
        summary,
        content: formatConversationContextContent(message),
        contentType: "text/markdown",
        tags: ["conversation", message.role],
        source: {
          role: "conversation",
          runId: message.runId || "conversation",
          nodeId: `message-${message.role}`,
        },
      });
      conversationContext.push({
        ref: written.ref,
        title,
        summary,
        role: message.role,
        createdAt: message.createdAt,
        attachments: message.attachments,
      });
    }
    return {
      task: payload.task,
      context: payload.context || {},
      conversationContext,
    };
  }

  async ensureExecutionConversation(workspaceId, sessionId, payload = {}) {
    try {
      return (await this.getConversation(workspaceId, sessionId)).conversation;
    } catch (error) {
      if (error.status !== 404) throw error;
      return (await this.createConversation(workspaceId, {
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

  resolveRuntimeRequest(runId, requestId, result) {
    return this.runtimeRegistry.resolveRequest(runId, requestId, result);
  }

  async steerAgentRun(workspaceId, runId, input, attachments = []) {
    const { run } = await this.getAgentRun(workspaceId, runId);
    const runtimeRunId = run.rootCoordinator?.status === "running"
      ? run.rootCoordinator.runtimeRunId
      : Object.values(run.nodeRuns || {}).find((nodeRun) =>
          ["running", "waiting_approval"].includes(nodeRun.status) && nodeRun.runtimeRunId
        )?.runtimeRunId;
    if (!runtimeRunId) {
      throw new AgentOrchestratorError("This run has no active Codex turn to steer.", 409);
    }
    return {
      ...(await this.runtimeRegistry.steerRun(runtimeRunId, input, await resolveWorkspaceAttachments(
        (await this.getWorkspace(workspaceId)).workspace,
        attachments
      ))),
      agentRunId: runId,
    };
  }

  async cancelAgentRun(workspaceId, runId) {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      const index = store.agentRuns.findIndex((item) => item.workspaceId === workspaceId && item.id === runId);
      if (index === -1) return this.cancelRuntimeRun(runId);
      const now = new Date().toISOString();
      const run = normalizeAgentRun(store.agentRuns[index]);
      const runtimeRunIds = new Set([runId]);
      if (["running", "waiting_approval"].includes(run.rootCoordinator?.status) && run.rootCoordinator.runtimeRunId) {
        runtimeRunIds.add(run.rootCoordinator.runtimeRunId);
      }
      for (const nodeRun of Object.values(run.nodeRuns || {})) {
        if (["running", "waiting_approval"].includes(nodeRun.status) && nodeRun.runtimeRunId) {
          runtimeRunIds.add(nodeRun.runtimeRunId);
        }
        if (["pending", "ready", "running", "waiting_approval"].includes(nodeRun.status)) {
          nodeRun.status = "cancelled";
          nodeRun.updatedAt = now;
          nodeRun.trace.push(createTrace("node_run_cancelled", { nodeRunId: nodeRun.id }, now));
        }
      }
      const cancellations = [...runtimeRunIds].map((runtimeRunId) => this.cancelRuntimeRun(runtimeRunId));
      run.status = "cancelled";
      run.error = { message: "Agent run was cancelled." };
      if (run.rootCoordinator) {
        run.rootCoordinator.status = "cancelled";
        run.rootCoordinator.runtimeRunId = "";
        run.rootCoordinator.updatedAt = now;
      }
      run.updatedAt = now;
      run.trace.push(createTrace("agent_run_cancelled", { runId, runtimeRunIds: [...runtimeRunIds], cancellations }, now));
      store.agentRuns[index] = run;
      await this.writeStore(store);
      return { cancelled: true, run, cancellations };
    });
  }

  async createAgentRun(project, rootSession, agent, request, { input, retrieval, managed = true } = {}) {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      this.findWorkspace(store, project.id);
      if (store.agentRuns.some((run) => run.workspaceId === project.id && run.id === request.runId)) {
        throw new AgentOrchestratorError(`Agent run ${request.runId} already exists.`, 409);
      }
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
        managed,
        status: "pending",
        input,
        output: undefined,
        error: undefined,
        request,
        nodeRuns,
        rootCoordinator: agentSnapshot.type === "blueprint" ? {
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
          item.workspaceId === project.id && item.id === rootSession.id
        );
        if (conversationIndex !== -1) {
          store.conversations[conversationIndex] = normalizeConversation({
            ...store.conversations[conversationIndex],
            activeAgentId: agent?.id || store.conversations[conversationIndex].activeAgentId || "",
            runIds: dedupe([...(store.conversations[conversationIndex].runIds || []), run.id]),
            updatedAt: now,
          });
        }
      }
      await this.writeStore(store);
      return run;
    });
  }

  async markAgentRunRunning(workspaceId, runId, runtimeRunId) {
    return this.updateAgentRun(workspaceId, runId, (run, now) => {
      const nodeRun = getPrimaryNodeRun(run);
      nodeRun.status = "running";
      nodeRun.runtimeRunId = runtimeRunId;
      nodeRun.updatedAt = now;
      run.status = "running";
      run.trace.push(createTrace("agent_run_started", { runId, runtimeRunId }, now));
      return run;
    });
  }

  async appendAgentRunTrace(workspaceId, runId, event) {
    return this.updateAgentRun(workspaceId, runId, (run, now) => {
      const trace = createTrace(event.type || "runtime_event", event, now);
      run.trace.push(trace);
      const nodeRun = getPrimaryNodeRun(run);
      nodeRun.trace.push(trace);
      nodeRun.updatedAt = now;
      return run;
    });
  }

  async completeAgentRun(workspaceId, runId, { status, output, nodeOutput, runtimeSession, trace = [], error } = {}) {
    return this.updateAgentRun(workspaceId, runId, (run, now) => {
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

  async updateAgentRun(workspaceId, runId, updater) {
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      this.findWorkspace(store, workspaceId);
      const index = store.agentRuns.findIndex((item) => item.workspaceId === workspaceId && item.id === runId);
      if (index === -1) throw new AgentOrchestratorError(`Agent run ${runId} was not found.`, 404);
      const now = new Date().toISOString();
      const updated = normalizeAgentRun(updater(deepClone(store.agentRuns[index]), now));
      updated.updatedAt = now;
      store.agentRuns[index] = updated;
      await this.writeStore(store);
      return { run: updated };
    });
  }

  async completeBlueprintDryRun(workspaceId, runId, request) {
    return this.updateAgentRun(workspaceId, runId, (run, now) => {
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
    const active = this.graphRunExecutions.get(runId);
    if (active) return active;
    const execution = this.runGraphCoordinator(project, agent, request, runId, onEvent)
      .finally(() => {
        if (this.graphRunExecutions.get(runId) === execution) this.graphRunExecutions.delete(runId);
      });
    this.graphRunExecutions.set(runId, execution);
    return execution;
  }

  async runGraphCoordinator(project, agent, request, runId, onEvent) {
    const maxDecisions = Math.max(1, Number(agent.executionPolicy?.maxDecisions || 50));
    this.graphRunEventHandlers.set(runId, onEvent);
    try {
      while (true) {
      const { run } = await this.getAgentRun(project.id, runId);
      if (["completed", "failed", "cancelled", "waiting_user", "waiting_approval"].includes(run.status)) {
        return { run };
      }
      if ((run.rootCoordinator?.decisionCount || 0) >= maxDecisions) {
        return this.completeBlueprintRun(project.id, runId, {
          status: "failed",
          error: { message: `Root coordinator exceeded the ${maxDecisions} decision limit.` },
        });
      }

      const rootNode = run.agentSnapshot.nodes.find((node) => node.id === run.agentSnapshot.rootNodeId);
      if (!rootNode) throw new AgentOrchestratorError("Root coordinator node was not found in the agent snapshot.", 500);
      const runtimeId = rootNode.runtimeId || run.agentSnapshot.runtimeId || request.runtimeId;
      const runtime = this.runtimeRegistry.getRuntime(runtimeId);
      const rootSession = await this.getRootRuntimeSession(project.id, run);
      const shouldForkRootSession = !run.rootCoordinator?.runtimeSession?.sessionId
        && Boolean(rootSession?.runtimeSessions?.codex?.sessionId);
      const coordinatorRunId = `${runId}:root:${(run.rootCoordinator?.decisionCount || 0) + 1}`;
      const runtimeApprovalPolicy = resolveNodeRuntimeApprovalPolicy(
        rootNode.runtimeApprovalPolicy,
        request.runtimeOptions?.runtimeApprovalPolicy
      );
      const coordinatorRuntimeOptions = withGraphToolRuntimeOptions(withContextToolRuntimeOptions(withRagToolRuntimeOptions({
        ...request.runtimeOptions,
        runtimeApprovalPolicy,
      }, project.id, rootNode.rag), {
        workspaceId: project.id,
        sessionId: run.rootSessionId,
        runId,
        role: "root",
      }), { workspaceId: project.id, runId });
      const prompt = buildRootCoordinatorPrompt(project, run, rootNode);
      const rootAgent = buildRootCoordinatorAgent(run.agentSnapshot, rootNode);

      const started = await this.updateAgentRun(project.id, runId, (current, now) => {
        current.status = "coordinating";
        current.rootCoordinator.status = "running";
        current.rootCoordinator.runtimeRunId = coordinatorRunId;
        current.rootCoordinator.updatedAt = now;
        current.trace.push(createTrace("root_coordinator_started", { coordinatorRunId }, now));
        return current;
      });
      onEvent?.({ type: "root_coordinator_started", runId, coordinatorRunId });

      let result;
      try {
        const executeRuntime = runtime.stream?.bind(runtime) || runtime.execute.bind(runtime);
        result = await executeRuntime({
          project,
          agent: rootAgent,
          prompt,
          rootSession,
          forkSession: shouldForkRootSession,
          runId: coordinatorRunId,
          runtimeOptions: {
            ...coordinatorRuntimeOptions,
            ignoreUserConfig: true,
          },
          attachments: run.rootCoordinator.decisionCount ? [] : request.attachments,
          onEvent: (event) => this.handleBlueprintRuntimeEvent({
            project,
            runId,
            runtimeRunId: coordinatorRunId,
            coordinator: true,
            event,
            onEvent,
          }),
        });
      } catch (error) {
        return this.completeBlueprintRun(project.id, runId, {
          status: "failed",
          error: serializeError(error),
        });
      }

      const afterTools = (await this.getAgentRun(project.id, runId)).run;
      const graphMutation = afterTools.trace.slice(started.run.trace.length).some((trace) => [
          "graph_node_dispatched",
          "graph_run_user_requested",
        ].includes(trace.type));
      const graphTerminal = ["completed", "failed", "cancelled", "waiting_user"].includes(afterTools.status)
        || (afterTools.status === "waiting_approval"
          && Object.values(afterTools.nodeRuns || {}).some((nodeRun) => nodeRun.status === "waiting_approval"));
      const graphAdvanced = graphTerminal || graphMutation;
      const updated = await this.updateAgentRun(project.id, runId, (current, now) => {
        if (!graphTerminal) current.status = "coordinating";
        current.rootCoordinator.status = graphTerminal ? current.rootCoordinator.status : "ready";
        current.rootCoordinator.decisionCount += 1;
        current.rootCoordinator.runtimeSession = result.runtimeSession;
        current.rootCoordinator.runtimeRunId = "";
        current.rootCoordinator.noProgressCount = graphAdvanced ? 0 : current.rootCoordinator.noProgressCount + 1;
        current.rootCoordinator.lastDecision = {
          action: graphAdvanced ? "graph_tool_managed" : "no_graph_tool_invoked",
          ...(graphAdvanced || !result.text ? {} : { response: result.text.slice(0, 1000) }),
        };
        current.rootCoordinator.updatedAt = now;
        current.trace.push(createTrace(graphAdvanced ? "root_coordinator_tool_managed" : "root_coordinator_no_progress", {
          runtimeSession: result.runtimeSession,
        }, now));
        return current;
      });
      onEvent?.({ type: graphAdvanced ? "root_coordinator_tool_managed" : "root_coordinator_no_progress", runId });
      if (graphTerminal) return updated;
      if (updated.run.rootCoordinator.noProgressCount >= 2) {
        return this.completeBlueprintRun(project.id, runId, {
          status: "failed",
          error: { message: "Root coordinator finished twice without invoking a graph scheduling tool." },
        });
      }
      }
    } finally {
      if (this.graphRunEventHandlers.get(runId) === onEvent) this.graphRunEventHandlers.delete(runId);
    }
  }

  async getRootRuntimeSession(workspaceId, run) {
    const runtimeSession = run.rootCoordinator?.runtimeSession;
    if (runtimeSession?.sessionId) {
      return {
        id: run.rootSessionId || `root:${run.id}`,
        runtimeSessions: { [runtimeSession.provider || "codex"]: runtimeSession },
      };
    }
    if (run.rootSessionId) {
      try {
        return (await this.getConversation(workspaceId, run.rootSessionId)).conversation;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    return undefined;
  }

  async handleBlueprintRuntimeEvent({ project, runId, runtimeRunId, nodeRunId = "", coordinator = false, event, onEvent }) {
    const runtimeEvent = {
      ...event,
      runId: event.runId || runtimeRunId,
      agentRunId: runId,
      runtimeRunId,
      runtimeScope: coordinator ? "coordinator" : "node",
      nodeRunId: nodeRunId || undefined,
    };
    const publishedEvent = event.type === "stdout" || event.type === "stderr"
      ? { ...runtimeEvent, type: "blueprint_runtime_output", stream: event.type }
      : runtimeEvent;
    if (shouldPersistBlueprintRuntimeEvent(event)) {
      const persistedEvent = compactRuntimeEvent(publishedEvent);
      const waiting = event.type === "runtime_request";
      await this.updateAgentRun(project.id, runId, (run, now) => {
        if (coordinator && ["runtime_request", "runtime_request_resolved"].includes(event.type)) {
          run.status = waiting ? "waiting_approval" : "coordinating";
          run.rootCoordinator.status = waiting ? "waiting_approval" : "running";
          run.rootCoordinator.updatedAt = now;
        } else if (!coordinator && ["runtime_request", "runtime_request_resolved"].includes(event.type)) {
          const nodeRun = run.nodeRuns[nodeRunId];
          run.status = waiting ? "waiting_approval" : "running";
          if (nodeRun) {
            nodeRun.status = waiting ? "waiting_approval" : "running";
            nodeRun.updatedAt = now;
          }
        }
        if (event.eventType === "runtime_session_started" && event.sessionId) {
          const runtimeSession = {
            provider: event.runtimeId || "codex",
            sessionId: event.sessionId,
            workspacePath: project.localWorkspacePath || "",
            status: "active",
            updatedAt: now,
          };
          if (coordinator) run.rootCoordinator.runtimeSession = runtimeSession;
          else if (nodeRunId && run.nodeRuns[nodeRunId]) run.nodeRuns[nodeRunId].runtimeSession = runtimeSession;
        }
        const trace = createTrace(event.type, persistedEvent, now);
        run.trace.push(trace);
        if (nodeRunId && run.nodeRuns[nodeRunId]) run.nodeRuns[nodeRunId].trace.push(trace);
        return run;
      });
    }
    onEvent?.(publishedEvent);
  }

  async executeBlueprintNode(project, agent, request, runId, nodeRunId, onEvent) {
    const { run, nodeRun } = await this.getNodeRun(project.id, runId, nodeRunId);
    const nodeDef = run.agentSnapshot.nodes.find((node) => node.id === nodeRun.nodeId);
    if (!nodeDef) throw new AgentOrchestratorError(`Blueprint node ${nodeRun.nodeId} was not found in snapshot.`, 500);
    const nodeRuntimeId = nodeDef.runtimeId || run.agentSnapshot.runtimeId || request.runtimeId;
    const runtime = this.runtimeRegistry.getRuntime(nodeRuntimeId);
    const runtimeRunId = `${nodeRun.id}:${randomUUID()}`;
    const nodeAgent = buildNodeAgent(run.agentSnapshot, nodeDef, agent);
    const nodeInput = buildNodeInput(run, nodeRun, request);
    const artifactBaseline = await snapshotExpectedWorkspaceArtifacts(
      project.localWorkspacePath,
      nodeInput.expectedArtifacts
    );
    const prompt = buildBlueprintNodePrompt(project, run, nodeDef, nodeInput);
    const runtimeApprovalPolicy = resolveNodeRuntimeApprovalPolicy(
      nodeDef.runtimeApprovalPolicy,
      request.runtimeOptions?.runtimeApprovalPolicy
    );
    const nodeRuntimeOptions = withContextToolRuntimeOptions(withRagToolRuntimeOptions({
      ...request.runtimeOptions,
      runtimeApprovalPolicy,
    }, project.id, nodeDef.rag), {
      workspaceId: project.id,
      sessionId: run.rootSessionId,
      runId,
      nodeRunId,
      role: "node",
    });

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
    onEvent?.({ type: "blueprint_node_started", runId, nodeRunId, nodeId: nodeRun.nodeId, runtimeRunId });

    let liveArtifacts = [];
    let completedFromArtifacts = false;
    const artifactMonitor = monitorExpectedWorkspaceArtifacts({
      workspacePath: project.localWorkspacePath,
      expectedArtifacts: nodeInput.expectedArtifacts,
      baseline: artifactBaseline,
      onUpdate: async (artifacts, stableAndComplete) => {
        liveArtifacts = await this.persistDiscoveredNodeArtifacts({
          project,
          run,
          nodeRun,
          nodeDef,
          artifacts,
        });
        onEvent?.({
          type: "blueprint_node_artifacts_updated",
          runId,
          nodeRunId,
          nodeId: nodeRun.nodeId,
          artifacts: liveArtifacts,
          complete: stableAndComplete,
        });
        if (stableAndComplete) {
          completedFromArtifacts = true;
          this.cancelRuntimeRun(runtimeRunId);
        }
      },
    });

    try {
      const executeRuntime = runtime.stream?.bind(runtime) || runtime.execute.bind(runtime);
      const result = await executeRuntime({
        project,
        agent: nodeAgent,
        prompt,
        rootSession: undefined,
        freshSession: true,
        runId: runtimeRunId,
        runtimeOptions: {
          ...nodeRuntimeOptions,
        },
        attachments: request.attachments,
        onEvent: (event) => this.handleBlueprintRuntimeEvent({
          project,
          runId,
          runtimeRunId,
          nodeRunId,
          event,
          onEvent,
        }),
      });
      await artifactMonitor.stop();
      const discoveredArtifacts = await this.discoverAndPersistNodeArtifacts({
        project,
        run,
        nodeRun,
        nodeDef,
        expectedArtifacts: nodeInput.expectedArtifacts,
        baseline: artifactBaseline,
      });
      const persistedResult = await this.externalizeLongNodeResult(project, run, nodeRun, nodeDef, {
        ...result,
        events: (result.events || []).map(compactRuntimeEvent),
        artifacts: mergeArtifacts(result.artifacts, mergeArtifacts(liveArtifacts, discoveredArtifacts)),
      });
      const resultApprovalPolicy = normalizeResultApprovalPolicy(nodeDef.resultApprovalPolicy);
      const updated = await this.updateAgentRun(project.id, runId, (current, now) => {
        const currentNode = current.nodeRuns[nodeRunId];
        currentNode.status = resultApprovalPolicy === "manual" ? "waiting_approval" : "completed";
        currentNode.output = persistedResult;
        currentNode.runtimeSession = persistedResult.runtimeSession;
        currentNode.runtimeRunId = "";
        currentNode.updatedAt = now;
        const trace = createTrace(resultApprovalPolicy === "manual" ? "node_run_approval_waiting" : "node_run_completed", {
          nodeRunId,
          nodeId: currentNode.nodeId,
          runtimeRunId,
          runtimeSession: persistedResult.runtimeSession,
          resultApprovalPolicy,
          runtimeApprovalPolicy,
        }, now);
        current.trace.push(trace);
        currentNode.trace.push(trace);
        current.status = graphRunStatusAfterNodeUpdate(current);
        return current;
      });
      onEvent?.({
        type: resultApprovalPolicy === "manual" ? "blueprint_node_waiting" : "blueprint_node_completed",
        runId,
        nodeRunId,
        nodeId: nodeRun.nodeId,
        result: persistedResult,
        prompt: resultApprovalPolicy === "manual" ? `${nodeDef.name || nodeRun.nodeId} 等待结果审核` : undefined,
      });
      return updated;
    } catch (error) {
      await artifactMonitor.stop();
      const discoveredArtifacts = await this.discoverAndPersistNodeArtifacts({
        project,
        run,
        nodeRun,
        nodeDef,
        expectedArtifacts: nodeInput.expectedArtifacts,
        baseline: artifactBaseline,
      });
      const recoveredArtifacts = mergeArtifacts(liveArtifacts, discoveredArtifacts);
      if (
        (completedFromArtifacts || isRuntimeTimeout(error))
        && expectedArtifactsSatisfied(nodeInput.expectedArtifacts, recoveredArtifacts)
      ) {
        const resultApprovalPolicy = normalizeResultApprovalPolicy(nodeDef.resultApprovalPolicy);
        const recoveredResult = {
          text: completedFromArtifacts
            ? "本节点的预期产物已稳定写入工作区，Hippo 已结束后续冗余处理，请由 Root 协调者继续验收。"
            : "Codex 运行超时，但 Hippo 已恢复本节点生成的预期产物，请由 Root 协调者继续验收。",
          artifacts: recoveredArtifacts,
          completedFromArtifacts,
          recoveredAfterTimeout: !completedFromArtifacts,
          warning: completedFromArtifacts ? undefined : serializeError(error),
        };
        const updated = await this.updateAgentRun(project.id, runId, (current, now) => {
          const currentNode = current.nodeRuns[nodeRunId];
          currentNode.status = resultApprovalPolicy === "manual" ? "waiting_approval" : "completed";
          currentNode.output = recoveredResult;
          currentNode.error = undefined;
          currentNode.runtimeRunId = "";
          currentNode.updatedAt = now;
          current.status = graphRunStatusAfterNodeUpdate(current);
          const trace = createTrace("node_run_artifacts_recovered", {
            nodeRunId,
            nodeId: currentNode.nodeId,
            artifactCount: recoveredArtifacts.length,
            completionSource: completedFromArtifacts ? "artifacts" : "timeout_recovery",
            timeout: completedFromArtifacts ? undefined : serializeError(error),
            resultApprovalPolicy,
          }, now);
          current.trace.push(trace);
          currentNode.trace.push(trace);
          return current;
        });
        onEvent?.({
          type: resultApprovalPolicy === "manual" ? "blueprint_node_waiting" : "blueprint_node_completed",
          runId,
          nodeRunId,
          nodeId: nodeRun.nodeId,
          result: recoveredResult,
          completedFromArtifacts,
          recoveredAfterTimeout: !completedFromArtifacts,
        });
        return updated;
      }
      const status = error.status === 499 || error.details?.cancelled ? "cancelled" : "failed";
      await this.updateAgentRun(project.id, runId, (current, now) => {
        const currentNode = current.nodeRuns[nodeRunId];
        currentNode.status = status;
        currentNode.error = serializeError(error);
        currentNode.runtimeRunId = "";
        currentNode.updatedAt = now;
        current.status = graphRunStatusAfterNodeUpdate(current);
        const trace = createTrace(`node_run_${status}`, {
          nodeRunId,
          nodeId: currentNode.nodeId,
          error: currentNode.error,
        }, now);
        current.trace.push(trace);
        currentNode.trace.push(trace);
        return current;
      });
      onEvent?.({ type: status, runId, nodeRunId, nodeId: nodeRun.nodeId, error: error.message });
      throw error;
    }
  }

  async discoverAndPersistNodeArtifacts({ project, run, nodeRun, nodeDef, expectedArtifacts, baseline }) {
    const artifacts = await discoverWorkspaceArtifacts(
      project.localWorkspacePath,
      expectedArtifacts,
      baseline
    );
    return this.persistDiscoveredNodeArtifacts({ project, run, nodeRun, nodeDef, artifacts });
  }

  async persistDiscoveredNodeArtifacts({ project, run, nodeRun, nodeDef, artifacts }) {
    if (!artifacts.length) return [];
    this.stateStore.repository.saveArtifacts(artifacts.map((artifact) => ({
      workspaceId: project.id,
      conversationId: run.rootSessionId || "",
      runId: run.id,
      nodeRunId: nodeRun.id,
      relativePath: artifact.relativePath,
      artifactType: artifact.type,
      mimeType: artifact.mimeType,
      contentHash: artifact.contentHash,
      sizeBytes: artifact.size,
      metadata: {
        source: "runtime",
        nodeId: nodeDef.id,
        attempt: nodeRun.attempt,
      },
    })));
    return artifacts;
  }

  async externalizeLongNodeResult(project, run, nodeRun, nodeDef, result) {
    const text = typeof result?.text === "string" ? result.text : "";
    if (!run.rootSessionId || text.length <= 12000 || extractContextRefs(text).length) return result;
    const summary = summarizeContextText(text);
    const contextId = `node-output-${createHash("sha256").update(nodeRun.id).digest("hex").slice(0, 24)}`;
    const written = await this.contextStore.write({
      workspacePath: project.localWorkspacePath,
      sessionId: run.rootSessionId,
      contextId,
      title: `${nodeDef.name || nodeRun.nodeId} 输出`,
      summary,
      content: text,
      contentType: "text/markdown",
      tags: ["node-output", nodeRun.nodeId],
      source: { role: "node", runId: run.id, nodeId: nodeRun.id, agentId: run.agentId },
    });
    return {
      ...result,
      contextRefs: [{ ref: written.ref, title: written.title, summary, reason: "节点完整输出" }],
      contextSummary: summary,
    };
  }

  async completeBlueprintRun(workspaceId, runId, { status, output, error } = {}) {
    const runtimeRunIds = [];
    const updated = await this.updateAgentRun(workspaceId, runId, (run, now) => {
      assertGraphRunMutable(run);
      const activeWorkers = Object.values(run.nodeRuns || {}).filter((nodeRun) =>
        (nodeRun.prototypeNodeId || nodeRun.nodeId) !== run.agentSnapshot.rootNodeId
        && ["pending", "ready", "running", "waiting_approval"].includes(nodeRun.status)
      );
      if (status === "completed" && activeWorkers.length) {
        throw new AgentOrchestratorError(
          `Run ${runId} cannot complete while ${activeWorkers.length} worker node(s) are active.`,
          409,
          { activeNodeRunIds: activeWorkers.map((nodeRun) => nodeRun.id) }
        );
      }
      if (["failed", "cancelled"].includes(status)) {
        for (const nodeRun of activeWorkers) {
          if (nodeRun.runtimeRunId) runtimeRunIds.push(nodeRun.runtimeRunId);
          nodeRun.status = status === "cancelled" ? "cancelled" : "failed";
          nodeRun.runtimeRunId = "";
          nodeRun.error = error || nodeRun.error;
          nodeRun.updatedAt = now;
        }
      }
      run.status = status;
      run.output = output || run.output;
      run.error = error;
      if (run.rootCoordinator) {
        run.rootCoordinator.status = status;
        run.rootCoordinator.updatedAt = now;
      }
      run.trace.push(createTrace(`blueprint_run_${status}`, { runId, status, error }, now));
      return run;
    });
    for (const runtimeRunId of runtimeRunIds) this.cancelRuntimeRun(runtimeRunId);
    return updated;
  }

  async persistRuntimeSession(workspaceId, conversationId, runtimeSession, agentId = "", runId = "") {
    if (!conversationId || !runtimeSession?.provider) return;
    return this.withStoreLock(async () => {
      const store = await this.readStore();
      this.findWorkspace(store, workspaceId);
      const index = store.conversations.findIndex((item) =>
        item.workspaceId === workspaceId && item.id === conversationId
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
    });
  }

  async retrieveRag(payload) {
    if (this.ragProvider.retrieve) return this.ragProvider.retrieve(payload);
    return this.client.vectorSearch(payload.workspaceSlug, payload);
  }

  async getWorkspaceKnowledgeIndex(workspaceId) {
    const { workspace } = await this.getWorkspace(workspaceId);
    return this.getWorkspaceKnowledgePlan(workspace, {});
  }

  async getWorkspaceKnowledgePlan(workspaceOrId, input = {}) {
    const payload = workspaceRagPlanSchema.parse(input);
    const workspace = typeof workspaceOrId === "string" ? (await this.getWorkspace(workspaceOrId)).workspace : workspaceOrId;
    const scope = resolveWorkspaceKnowledgeScope(workspace, payload);
    const knowledge = this.resourceManager
      ? scope.empty
        ? { domains: [], topics: [] }
        : await this.resourceManager.getWorkspaceKnowledgeIndex(scope)
      : { domains: [], topics: [] };
    return {
      workspace,
      scope,
      knowledge: omitKnowledgeDocuments(knowledge),
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

  async listWorkspaceKnowledgeDocuments(workspaceOrId, input = {}) {
    const payload = workspaceRagDocumentsSchema.parse(input);
    const workspace = typeof workspaceOrId === "string" ? (await this.getWorkspace(workspaceOrId)).workspace : workspaceOrId;
    const scope = resolveWorkspaceKnowledgeScope(workspace, payload);
    const listing = this.resourceManager
      ? scope.empty
        ? emptyKnowledgeDocumentListing(this.resourceManager.knowledgeDir, payload)
        : await this.resourceManager.listWorkspaceKnowledgeDocuments(scope, payload)
      : emptyKnowledgeDocumentListing("", payload);
    return { scope, ...listing };
  }

  async searchWorkspaceKnowledge(workspaceOrId, input = {}) {
    const payload = workspaceRagSearchSchema.parse(input);
    const workspace = typeof workspaceOrId === "string" ? (await this.getWorkspace(workspaceOrId)).workspace : workspaceOrId;
    const scope = resolveWorkspaceKnowledgeScope(workspace, payload);
    const knowledgeIndex = this.resourceManager
      ? scope.empty
        ? { domains: [], topics: [] }
        : await this.resourceManager.getWorkspaceKnowledgeIndex(scope)
      : { domains: [], topics: [] };
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
        query: payload.query,
        topN: payload.topN,
      });
      searches.push({ topic, workspaceSlug: sync.workspaceSlug, documentNames: sync.documentNames, result });
    }

    const rootPath = this.resourceManager?.knowledgeDir || "";
    const { results, unresolvedResultCount } = mergeRagResults(searches, rootPath);
    return {
      skipped: false,
      query: input.query,
      rootPath,
      scope,
      topics: knowledgeIndex.topics,
      searches,
      results,
      unresolvedResultCount,
    };
  }

  async readStore() {
    return normalizeStore(await this.stateStore.read());
  }

  async writeStore(store) {
    await this.stateStore.write(normalizeStore(store));
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

  findWorkspace(store, workspaceId) {
    const workspace = store.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new AgentOrchestratorError(`Workspace ${workspaceId} was not found.`, 404);
    return workspace;
  }
}

function shouldPersistBlueprintRuntimeEvent(event) {
  if (["runtime_request", "runtime_request_resolved", "stderr"].includes(event.type)) return true;
  if (event.type !== "runtime_event") return false;
  return [
    "runtime_session_started",
    "turn_started",
    "turn_completed",
    "item_started",
    "item_completed",
    "error",
  ].includes(event.eventType);
}

const ARTIFACT_EXTENSION_TYPES = new Map([
  [".png", ["image", "image/png"]],
  [".jpg", ["image", "image/jpeg"]],
  [".jpeg", ["image", "image/jpeg"]],
  [".webp", ["image", "image/webp"]],
  [".gif", ["image", "image/gif"]],
  [".avif", ["image", "image/avif"]],
  [".svg", ["image", "image/svg+xml"]],
]);

const ARTIFACT_SCAN_EXCLUDED_DIRECTORIES = new Set([".git", ".hippo", "node_modules"]);

async function snapshotExpectedWorkspaceArtifacts(workspacePath, expectedArtifacts) {
  if (!workspacePath || !Array.isArray(expectedArtifacts) || !expectedArtifacts.length) return new Map();
  return scanWorkspaceArtifacts(workspacePath, expectedArtifacts);
}

async function discoverWorkspaceArtifacts(workspacePath, expectedArtifacts, baseline = new Map()) {
  if (!workspacePath || !Array.isArray(expectedArtifacts) || !expectedArtifacts.length) return [];
  const current = await scanWorkspaceArtifacts(workspacePath, expectedArtifacts);
  const changed = [];
  for (const [relativePath, metadata] of current) {
    const previous = baseline.get(relativePath);
    if (previous && previous.size === metadata.size && previous.mtimeMs === metadata.mtimeMs) continue;
    const content = await fs.readFile(metadata.absolutePath);
    changed.push({
      type: metadata.type,
      path: metadata.absolutePath,
      relativePath,
      mimeType: metadata.mimeType,
      size: metadata.size,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    });
  }
  return changed.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function monitorExpectedWorkspaceArtifacts({
  workspacePath,
  expectedArtifacts,
  baseline,
  onUpdate,
  intervalMs = 1000,
}) {
  if (!workspacePath || !Array.isArray(expectedArtifacts) || !expectedArtifacts.length) {
    return { stop: async () => {} };
  }
  let stopped = false;
  let timer;
  let lastFingerprint = "";
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    resolveDone();
  };
  const tick = async () => {
    if (stopped) return;
    try {
      const artifacts = await discoverWorkspaceArtifacts(workspacePath, expectedArtifacts, baseline);
      const fingerprint = artifacts
        .map((artifact) => `${artifact.relativePath}:${artifact.size}:${artifact.contentHash}`)
        .join("|");
      const stableAndComplete = Boolean(fingerprint)
        && fingerprint === lastFingerprint
        && expectedArtifactsSatisfied(expectedArtifacts, artifacts);
      if (fingerprint && (fingerprint !== lastFingerprint || stableAndComplete)) {
        await onUpdate?.(artifacts, stableAndComplete);
      }
      lastFingerprint = fingerprint;
      if (stableAndComplete) return finish();
    } catch {
      // Artifact discovery is advisory; runtime execution remains authoritative on scan errors.
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop: async () => {
      finish();
      await done;
    },
  };
}

async function scanWorkspaceArtifacts(workspacePath, expectedArtifacts) {
  const root = path.resolve(workspacePath);
  const expectedTypes = new Set(expectedArtifacts.map((item) => String(item.type || "").toLowerCase()));
  const includeAnyFile = expectedTypes.has("file") || expectedTypes.has("artifact");
  const files = new Map();
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ARTIFACT_SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(directory, entry.name);
      const extensionInfo = ARTIFACT_EXTENSION_TYPES.get(path.extname(entry.name).toLowerCase());
      const type = extensionInfo?.[0] || "file";
      if (!includeAnyFile && !expectedTypes.has(type)) continue;
      const stat = await fs.stat(absolutePath);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      files.set(relativePath, {
        absolutePath,
        type,
        mimeType: extensionInfo?.[1] || "application/octet-stream",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  };
  await visit(root);
  return files;
}

function expectedArtifactsSatisfied(expectedArtifacts, artifacts) {
  if (!Array.isArray(expectedArtifacts) || !expectedArtifacts.length) return false;
  return expectedArtifacts.every((expected) => {
    const type = String(expected.type || "").toLowerCase();
    const count = Math.max(1, Number(expected.count) || 1);
    return artifacts.filter((artifact) => type === "file" || type === "artifact" || artifact.type === type).length >= count;
  });
}

function mergeArtifacts(runtimeArtifacts, discoveredArtifacts) {
  const merged = new Map();
  for (const artifact of [...(Array.isArray(runtimeArtifacts) ? runtimeArtifacts : []), ...discoveredArtifacts]) {
    const key = artifact.relativePath || artifact.path || JSON.stringify(artifact);
    merged.set(key, artifact);
  }
  return [...merged.values()];
}

function isRuntimeTimeout(error) {
  return error?.status === 504 || /timed?\s*out|timeout/i.test(String(error?.message || ""));
}

function compactRuntimeEvent(event) {
  return compactRuntimeValue(event, 0);
}

function compactRuntimeValue(value, depth) {
  if (typeof value === "string") {
    return value.length > 8000 ? `${value.slice(0, 8000)}\n...[truncated ${value.length - 8000} characters]` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[truncated nested value]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => compactRuntimeValue(item, depth + 1));
    if (value.length > 50) items.push(`[truncated ${value.length - 50} items]`);
    return items;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    compactRuntimeValue(item, depth + 1),
  ]));
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
    options.rag?.enabled
      ? `当前节点已启用 RAG 工具。可使用 hippo_rag_scope 查看授权范围、hippo_rag_list_documents 分页定位文档、hippo_rag_search 执行语义检索；检索上限为 Top ${options.rag.topN}。不要在执行前默认检索。`
      : "当前节点未配置 RAG 工具，不要执行知识库检索。",
    options.runtimeOptions?.sandboxMode ? `本轮 Codex sandbox 权限：${options.runtimeOptions.sandboxMode}` : "",
    project.localWorkspacePath ? `本地工作区目录：\n${project.localWorkspacePath}` : "",
    context ? `运行时上下文：\n${JSON.stringify(context, null, 2)}` : "",
    options.attachments?.length ? `本轮附件（路径均位于当前工作区）：\n${options.attachments.map((item) => `- ${item.kind}: ${item.name}\n  ${item.absolutePath}`).join("\n")}` : "",
    `任务：\n${task}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function agentSchemas() {
  return {
    createWorkspaceSchema,
    updateWorkspaceSchema,
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
    attachments: normalizeStoredAttachments(message.attachments),
  }));
}

function normalizeStoredAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((item) => item && typeof item === "object").map((item) => ({
    id: String(item.id || ""),
    kind: ["file", "folder", "image"].includes(item.kind) ? item.kind : "file",
    name: String(item.name || path.posix.basename(String(item.path || "attachment"))),
    path: String(item.path || ""),
    mimeType: String(item.mimeType || ""),
    size: Math.max(0, Number(item.size) || 0),
    childCount: Math.max(0, Number(item.childCount) || 0),
  })).filter((item) => item.id && item.path);
}

async function removeUnreferencedAttachmentBatches(workspace, deletedConversation, remainingConversations) {
  if (!workspace?.localWorkspacePath || !deletedConversation) return;
  const deletedBatches = attachmentBatchPaths(deletedConversation.messages);
  const referencedBatches = new Set(
    remainingConversations
      .filter((conversation) => conversation.workspaceId === workspace.id)
      .flatMap((conversation) => attachmentBatchPaths(conversation.messages))
  );
  for (const batchPath of deletedBatches) {
    if (referencedBatches.has(batchPath)) continue;
    const absolutePath = path.resolve(workspace.localWorkspacePath, ...batchPath.split("/"));
    const relative = path.relative(path.resolve(workspace.localWorkspacePath), absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    await fs.rm(absolutePath, { recursive: true, force: true });
  }
}

function attachmentBatchPaths(messages) {
  const batches = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const attachment of normalizeStoredAttachments(message.attachments)) {
      const match = attachment.path.match(/^\.hippo\/attachments\/[^/]+/);
      if (match) batches.add(match[0]);
    }
  }
  return [...batches];
}

async function resolveWorkspaceAttachments(project, attachments) {
  const workspaceRoot = path.resolve(project.localWorkspacePath || "");
  if (!project.localWorkspacePath || !Array.isArray(attachments)) return [];
  const realRoot = await fs.realpath(workspaceRoot);
  return Promise.all(normalizeStoredAttachments(attachments).map(async (item) => {
    const target = path.resolve(workspaceRoot, item.path);
    const relative = path.relative(workspaceRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new AgentOrchestratorError(`附件路径不在工作区内：${item.path}`, 403);
    }
    let absolutePath;
    try {
      absolutePath = await fs.realpath(target);
    } catch (error) {
      if (error.code === "ENOENT") throw new AgentOrchestratorError(`附件不存在：${item.path}`, 404);
      throw error;
    }
    const realRelative = path.relative(realRoot, absolutePath);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new AgentOrchestratorError(`附件路径不在工作区内：${item.path}`, 403);
    }
    return { ...item, path: relative.split(path.sep).join("/"), absolutePath };
  }));
}

function formatSkill(skill) {
  const details = [skill.description, skill.instructions].filter(Boolean).join(" ");
  return details ? `- ${skill.name}: ${details}` : `- ${skill.name}`;
}

function buildRuntimeOptions(payload) {
  return stripEmptyObject({
    sandboxMode: ["workspace-write", "read-only", "danger-full-access"].includes(payload.sandboxMode)
      ? payload.sandboxMode
      : "",
  });
}

function withHippoSystemToolRuntimeOptions(runtimeOptions) {
  return {
    ...runtimeOptions,
    mcpServerUrls: {
      ...(runtimeOptions?.mcpServerUrls || {}),
      hippo: `http://127.0.0.1:${config.wrapperPort}/mcp`,
    },
  };
}

function withRagToolRuntimeOptions(runtimeOptions, workspaceId, ragValue) {
  const rag = normalizeNodeRag(ragValue);
  if (!rag.enabled) return runtimeOptions;
  const query = new URLSearchParams({ workspaceId, topN: String(rag.topN) });
  return {
    ...runtimeOptions,
    mcpServerUrls: {
      ...(runtimeOptions?.mcpServerUrls || {}),
      hippo_rag: `http://127.0.0.1:${config.wrapperPort}/mcp/rag?${query}`,
    },
  };
}

function withContextToolRuntimeOptions(runtimeOptions, { workspaceId, sessionId, runId, nodeRunId = "", role = "root" } = {}) {
  if (!workspaceId || !sessionId || !runId) return runtimeOptions;
  const query = new URLSearchParams({ workspaceId, sessionId, runId, role });
  if (nodeRunId) query.set("nodeRunId", nodeRunId);
  return {
    ...runtimeOptions,
    mcpServerUrls: {
      ...(runtimeOptions?.mcpServerUrls || {}),
      hippo_context: `http://127.0.0.1:${config.wrapperPort}/mcp/context?${query}`,
    },
  };
}

function withGraphToolRuntimeOptions(runtimeOptions, { workspaceId, runId } = {}) {
  const query = new URLSearchParams({ workspaceId, runId });
  return {
    ...runtimeOptions,
    mcpServerUrls: {
      ...(runtimeOptions?.mcpServerUrls || {}),
      hippo_graph: `http://127.0.0.1:${config.wrapperPort}/mcp/graph?${query}`,
    },
  };
}

function stripEmptyObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function dedupeBy(items, keyOf) {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()];
}

function definedOnly(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function primaryDomain(value) {
  return String(value || "").replaceAll("\\", "/").split("/").filter(Boolean)[0] || "";
}

function normalizeTopicRefs(topicRefs = [], domainRefs = []) {
  const domains = new Set((domainRefs || []).map(primaryDomain).filter(Boolean));
  return dedupe((topicRefs || []).map(topicPath).filter((value) => {
    if (!value) return false;
    return !domains.size || domains.has(primaryDomain(value));
  }));
}

function normalizeDomainRefs(domainRefs = [], topicRefs = []) {
  return dedupe([
    ...(domainRefs || []).map(primaryDomain),
    ...(topicRefs || []).map(primaryDomain),
  ]);
}

function resolveWorkspaceKnowledgeScope(workspace, input = {}) {
  const workspaceDomains = normalizeDomainRefs(workspace.knowledgeDomainRefs || [], workspace.knowledgeTopicRefs || []);
  const requestedDomains = normalizeDomainRefs(input.domainRefs || [], input.topicRefs || []);
  const hasRequestedDomains = Boolean(input.domainRefs?.length);
  const hasRequestedTopics = Boolean(input.topicRefs?.length);
  const domainRefs = requestedDomains.length
    ? workspaceDomains.filter((domain) => requestedDomains.includes(domain))
    : workspaceDomains;
  const workspaceTopics = normalizeTopicRefs(workspace.knowledgeTopicRefs || [], domainRefs);
  const requestedTopics = normalizeTopicRefs(input.topicRefs || [], domainRefs);
  const topicRefs = requestedTopics.length
    ? requestedTopics.filter((topic) => !workspaceTopics.length || workspaceTopics.includes(topic))
    : workspaceTopics;
  const empty = !domainRefs.length || (hasRequestedTopics && !topicRefs.length) || (hasRequestedDomains && !requestedDomains.length);
  return { domainRefs, topicRefs, empty };
}

function omitKnowledgeDocuments(knowledge = {}) {
  const omitFromTopic = ({ documents: _documents, ...topic }) => topic;
  return {
    domains: (knowledge.domains || []).map((domain) => ({
      ...domain,
      topics: (domain.topics || []).map(omitFromTopic),
    })),
    topics: (knowledge.topics || []).map(omitFromTopic),
  };
}

function emptyKnowledgeDocumentListing(rootPath, payload) {
  return {
    rootPath,
    filters: {
      suffixes: dedupe((payload.suffixes || []).map((suffix) => {
        const value = String(suffix).trim().toLowerCase();
        return value.startsWith(".") ? value : `.${value}`;
      })),
    },
    pagination: { page: payload.page, pageSize: payload.pageSize, total: 0, totalPages: 0 },
    documents: [],
  };
}

function topicPath(value) {
  const parts = String(value || "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
}

function mergeRagResults(searches = [], rootPath = "") {
  const rows = [];
  let unresolvedResultCount = 0;
  for (const search of searches) {
    const rawResults = Array.isArray(search.result?.results)
      ? search.result.results
      : Array.isArray(search.result?.sources)
        ? search.result.sources
        : [];
    for (const item of rawResults) {
      const score = Number(item.score ?? item.metadata?.score ?? 0);
      const document = matchRagResultDocument(item, search.topic.documents || []);
      if (!document) {
        unresolvedResultCount += 1;
        continue;
      }
      rows.push({
        ...item,
        score,
        topicPath: search.topic.path,
        topicName: search.topic.name,
        domainPath: search.topic.domainPath,
        domainName: search.topic.domainName,
        file: {
          rootPath,
          relativePath: document.relativePath,
          path: path.join(rootPath, ...document.relativePath.split("/")),
        },
      });
    }
  }
  return {
    results: rows
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 12),
    unresolvedResultCount,
  };
}

function matchRagResultDocument(result, documents = []) {
  const metadata = result?.metadata || {};
  const hints = dedupe([
    metadata.sourcePath,
    metadata.title,
    metadata.chunkSource,
    fileNameFromUrl(metadata.url),
    String(result?.text || "").match(/sourceDocument:\s*([^\n<]+)/i)?.[1]?.trim(),
  ].map(normalizeDocumentHint));
  const exact = documents.find((document) => hints.includes(normalizeDocumentHint(document.relativePath)));
  if (exact) return exact;
  const byName = documents.filter((document) => {
    const names = [document.title, path.posix.basename(document.relativePath)].map(normalizeDocumentHint);
    return names.some((name) => hints.includes(name));
  });
  if (byName.length === 1) return byName[0];
  return documents.length === 1 ? documents[0] : undefined;
}

function normalizeDocumentHint(value) {
  return String(value || "").replaceAll("\\", "/").trim().toLowerCase();
}

function fileNameFromUrl(value) {
  if (!value) return "";
  try {
    return path.posix.basename(decodeURIComponent(new URL(String(value)).pathname));
  } catch {
    return path.posix.basename(String(value).replaceAll("\\", "/"));
  }
}

function normalizeWorkspaces(workspaces) {
  if (!Array.isArray(workspaces)) return [];
  return workspaces.map((workspace) => {
    const knowledgeTopicRefs = Array.isArray(workspace.knowledgeTopicRefs)
      ? normalizeTopicRefs(workspace.knowledgeTopicRefs, workspace.knowledgeDomainRefs)
      : [];
    return {
      id: workspace.id,
      name: workspace.name,
      description: workspace.description || "",
      hippoMcpEnabled: typeof workspace.hippoMcpEnabled === "boolean"
        ? workspace.hippoMcpEnabled
        : workspace.metadata?.isDefault === true,
      agentIds: Array.isArray(workspace.agentIds) ? workspace.agentIds : [],
      knowledgeDomainRefs: normalizeDomainRefs(
        Array.isArray(workspace.knowledgeDomainRefs) ? workspace.knowledgeDomainRefs : [],
        knowledgeTopicRefs
      ),
      knowledgeTopicRefs,
      localWorkspacePath: workspace.localWorkspacePath || "",
      localWorkspaceFolderName: workspace.localWorkspaceFolderName || "",
      metadata: workspace.metadata || {},
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    };
  });
}

function normalizeAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.map(normalizeAgent);
}

function normalizeAgent(agent) {
  const current = agent || {};
  const type = current.type === "blueprint" ? "blueprint" : "single";
  const nodes = type === "blueprint" ? normalizeAgentNodes(current.nodes) : [];
  return definedOnly({
    $schema: AGENT_BLUEPRINT_SCHEMA_ID,
    schemaVersion: AGENT_BLUEPRINT_SCHEMA_VERSION,
    id: current.id,
    type,
    version: Number(current.version || 1),
    name: current.name,
    description: current.description || "",
    systemPrompt: current.systemPrompt || "",
    skills: normalizeSkills(current.skills),
    mcpServers: dedupe(Array.isArray(current.mcpServers) ? current.mcpServers : []),
    runtimeId: current.runtimeId || config.defaultRuntimeId,
    rag: normalizeNodeRag(current.rag),
    rootNodeId: type === "blueprint" ? current.rootNodeId || nodes[0]?.id || "" : "",
    nodes,
    edges: type === "blueprint" ? normalizeAgentEdges(current.edges) : [],
    executionPolicy: normalizeExecutionPolicy(current.executionPolicy),
    metadata: current.metadata || {},
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  });
}

function normalizeAgentNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => definedOnly({
    id: String(node.id || "").trim(),
    kind: "task",
    resultApprovalPolicy: normalizeResultApprovalPolicy(node.resultApprovalPolicy),
    runtimeApprovalPolicy: normalizeRuntimeApprovalPolicy(node.runtimeApprovalPolicy),
    transitionInstruction: String(node.transitionInstruction || ""),
    name: node.name || node.id || "",
    description: String(node.description || ""),
    agentId: node.agentId || undefined,
    systemPrompt: String(node.systemPrompt || ""),
    runtimeId: node.runtimeId || undefined,
    rag: normalizeNodeRag(node.rag),
    skills: normalizeSkills(node.skills),
    mcpServers: dedupe(Array.isArray(node.mcpServers) ? node.mcpServers : []),
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

function normalizeNodeRag(value) {
  const rag = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: rag.enabled === true,
    topN: Math.min(100, Math.max(1, Number(rag.topN) || 4)),
  };
}

function normalizeSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.map((skill) => stripEmptyObject({
    name: String(skill?.name || "").trim(),
    description: skill?.description || "",
    instructions: skill?.instructions || "",
  })).filter((skill) => skill.name);
}

function normalizeExecutionPolicy(value) {
  const policy = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    maxDecisions: Math.min(1000, Math.max(1, Number(policy.maxDecisions) || 50)),
  };
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
  const schemaResult = validateAgentBlueprintSchema(normalized);
  if (!schemaResult.valid) {
    throw new AgentOrchestratorError("Agent blueprint does not match schema v1.", 400, {
      schemaId: AGENT_BLUEPRINT_SCHEMA_ID,
      schemaVersion: AGENT_BLUEPRINT_SCHEMA_VERSION,
      errors: schemaResult.errors,
    });
  }
  if (normalized.type !== "blueprint") return normalized;
  if (!normalized.nodes.length) {
    throw new AgentOrchestratorError("Blueprint agent requires at least one node.", 400);
  }
  const nodeIds = new Set();
  for (const node of normalized.nodes) {
    if (nodeIds.has(node.id)) {
      throw new AgentOrchestratorError(`Blueprint agent has duplicate node id: ${node.id}.`, 400);
    }
    nodeIds.add(node.id);
  }
  if (!normalized.rootNodeId || !nodeIds.has(normalized.rootNodeId)) {
    throw new AgentOrchestratorError("Blueprint agent rootNodeId must reference an existing node.", 400);
  }
  if (normalized.rootNodeId !== "root") {
    throw new AgentOrchestratorError("Blueprint agent rootNodeId must be root.", 400);
  }
  const edgeIds = new Set();
  for (const edge of normalized.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new AgentOrchestratorError(`Blueprint edge ${edge.id} references an unknown node.`, 400);
    }
    if (edge.from === edge.to) {
      throw new AgentOrchestratorError(`Blueprint edge ${edge.id} cannot point to the same node.`, 400);
    }
    if (edgeIds.has(edge.id)) {
      throw new AgentOrchestratorError(`Blueprint has duplicate edge id: ${edge.id}.`, 400);
    }
    edgeIds.add(edge.id);
  }
  const edgeKeys = new Set();
  for (const edge of normalized.edges) {
    const key = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) {
      throw new AgentOrchestratorError(`Blueprint has duplicate edge: ${key}.`, 400);
    }
    edgeKeys.add(key);
  }
  assertAcyclic(normalized.nodes, normalized.edges);
  assertReachableFromRoot(normalized.nodes, normalized.edges, normalized.rootNodeId);
  return normalized;
}

function assertAcyclic(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) throw new AgentOrchestratorError(`Blueprint contains a cycle at node ${nodeId}.`, 400);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) || []) visit(next);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) visit(node.id);
}

function assertReachableFromRoot(nodes, edges, rootNodeId) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);
  const reachable = new Set();
  const visit = (nodeId) => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const next of outgoing.get(nodeId) || []) visit(next);
  };
  visit(rootNodeId);
  const unreachable = nodes.map((node) => node.id).filter((nodeId) => !reachable.has(nodeId));
  if (unreachable.length) {
    throw new AgentOrchestratorError(
      `Blueprint contains nodes that are unreachable from root: ${unreachable.join(", ")}.`,
      400,
      { unreachableNodeIds: unreachable }
    );
  }
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
    rootNodeId: normalized.rootNodeId || "",
    nodes: normalized.nodes || [],
    edges: normalized.edges || [],
    executionPolicy: normalized.executionPolicy || {},
    metadata: normalized.metadata || {},
  }));
}

function createNodeRuns({ runId, request, agentSnapshot, input, now }) {
  if (agentSnapshot.type !== "blueprint") {
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
    id: `${runId}:${nodeId || "root"}${agentSnapshot.type === "blueprint" ? `:${attempt}` : ""}`,
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
  if (statuses.includes("waiting_approval")) return "waiting_approval";
  return "coordinating";
}

function findDurableResultApprovalNode(run) {
  if (!run?.agentSnapshot || run.agentSnapshot.type !== "blueprint") return undefined;
  return Object.values(run.nodeRuns || {}).find((nodeRun) => {
    if (!nodeRun.output || nodeRun.approval?.resumed) return false;
    if (!["waiting_approval", "failed"].includes(nodeRun.status)) return false;
    const node = run.agentSnapshot.nodes.find((item) => item.id === (nodeRun.prototypeNodeId || nodeRun.nodeId));
    return normalizeResultApprovalPolicy(node?.resultApprovalPolicy) === "manual";
  });
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
    name: nodeDef.name || agentSnapshot.name || fallbackAgent?.name || "Blueprint Node",
    description: nodeDef.description || agentSnapshot.description || "",
    systemPrompt: [agentSnapshot.systemPrompt, nodeDef.systemPrompt].filter(Boolean).join("\n\n"),
    skills: resolveNodeSkills(agentSnapshot, nodeDef),
    mcpServers: nodeDef.mcpServers?.length ? nodeDef.mcpServers : agentSnapshot.mcpServers || [],
    runtimeId: nodeDef.runtimeId || agentSnapshot.runtimeId || fallbackAgent?.runtimeId || config.defaultRuntimeId,
    rag: normalizeNodeRag(nodeDef.rag),
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
    skills: resolveNodeSkills(agentSnapshot, rootNode),
    mcpServers: rootNode.mcpServers?.length ? rootNode.mcpServers : agentSnapshot.mcpServers || [],
    runtimeId: rootNode.runtimeId || agentSnapshot.runtimeId || config.defaultRuntimeId,
  };
}

function buildRootCoordinatorPrompt(project, run, rootNode) {
  const prototype = {
    rootNodeId: run.agentSnapshot.rootNodeId,
    nodes: run.agentSnapshot.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      interfaceDescription: node.description,
      workerInstructions: node.systemPrompt || "",
      staticInput: node.input,
      availableSkills: resolveNodeSkills(run.agentSnapshot, node).map((skill) => ({
        name: skill.name,
        description: skill.description || "",
      })),
      rag: normalizeNodeRag(node.rag),
      resultApprovalPolicy: normalizeResultApprovalPolicy(node.resultApprovalPolicy),
      runtimeApprovalPolicy: normalizeRuntimeApprovalPolicy(node.runtimeApprovalPolicy),
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
      approval: nodeRun.approval,
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
    `不可变的原始用户请求：\n${JSON.stringify(buildOriginalRequest(run), null, 2)}`,
    run.rootCoordinator?.decisionCount === 0 && run.input?.conversationContext?.length
      ? `同一 Hippo 会话的上下文目录（正文未展开）：\n${JSON.stringify(run.input.conversationContext, null, 2)}`
      : run.rootCoordinator?.decisionCount === 0
        ? "同一 Hippo 会话中没有可用的前序上下文引用。"
        : "前序会话上下文目录已在本 Run 首次决策时对齐；继续使用当前 Root Codex session，必要时通过 hippo_context_read/search 获取长内容。",
    `Agent 图原型：\n${JSON.stringify(prototype, null, 2)}`,
    `当前 Runtime Graph：\n${JSON.stringify(runtimeGraph, null, 2)}`,
    "Runtime Graph 中 approval.resumed=true 表示用户已经确认该节点结果；应直接按照确认值和流转规则继续，不得再次请求同一项确认。",
    run.userResponses?.length ? `用户后续回复：\n${JSON.stringify(run.userResponses, null, 2)}` : "当前没有用户后续回复。",
    rootNode.transitionInstruction ? `Root 结果处置规则：\n${rootNode.transitionInstruction}` : "Root 未配置额外结果处置规则，按默认拓扑开始调度。",
    "先结合 Root Codex session 和会话上下文目录解析当前请求中的指代，例如“这篇”“上一个”“继续”“按刚才的方案”。摘要只用于定位；需要正文或关键事实时调用 hippo_context_read，无法确定引用时调用 hippo_context_search/list。已有唯一明确对象时不得再次要求用户提供；存在多个合理对象且无法消歧时才请求确认。",
    "派发前先理解目标节点的接口描述、工作指令、静态输入、可用 Skill、RAG 和审批策略，再确定该节点应接收什么输入、应返回什么输出。不要把完整会话历史原样复制给工作节点；只注入完成该节点职责所需的事实、正文、路径、上游结果和约束。",
    "每次派发节点时，必须以不可变的原始用户请求为基线，并在 input 中提供完整执行信封：nodeTask 是当前节点应完成的具体子任务；relevantContext 只包含当前节点需要的会话历史、上游内容和已知交付路径；requirements 保留原始请求中与当前节点相关且不可丢失的约束；expectedArtifacts 描述必须实际产出的文件、图片或其他交付物。不得用摘要、方案、提示词或占位符替代原始请求要求的真实产物。",
    "派发 input 的固定结构为：{\"nodeTask\":\"具体子任务\",\"relevantContext\":{},\"contextRefs\":[{\"ref\":\"ctx://...\",\"title\":\"标题\",\"summary\":\"摘要\",\"reason\":\"与节点任务的关系\"}],\"requirements\":[\"不可丢失的约束\"],\"expectedArtifacts\":[{\"type\":\"image|file|text|其他类型\",\"count\":1,\"description\":\"验收说明\"}]}。长正文和长节点结果应通过 contextRefs 传递，不得复制进 relevantContext。若节点需要某项 Skill，应优先选择 availableSkills 中具备该能力的节点，并在 nodeTask 中明确要求调用对应的 $skill-name。",
    "节点完成后，必须同时对照原始用户请求、requirements 和 expectedArtifacts 检查结果。真实产物缺失时不得完成 Run，应返工、调度其他合适节点或向用户说明失败。",
    normalizeNodeRag(rootNode.rag).enabled
      ? `Root 节点已启用独立 RAG 工具。可使用 hippo_rag_scope、hippo_rag_list_documents 和 hippo_rag_search，Top N 固定为 ${normalizeNodeRag(rootNode.rag).topN}；不要默认检索。`
      : "Root 节点未配置 RAG 工具。",
    "当前 Codex turn 已注入仅属于本 Run 的 Hippo Graph Tool：hippo_get_agent_run、hippo_dispatch_graph_node、hippo_request_graph_user、hippo_complete_graph_run、hippo_fail_graph_run。工具已绑定当前 workspace 和 run，不需要也不得自行拼接系统 ID。",
    "必须通过 Graph Tool 推进运行。可以在同一 turn 中连续调度节点，直到 Run 完成、失败、等待审批或等待用户。禁止用普通文本或 JSON 模拟工具调用；如果工具参数校验失败，应根据工具错误修正参数后再次调用。",
  ].join("\n\n");
}

function buildNodeInput(run, nodeRun, request) {
  const parent = nodeRun.parentNodeRunId ? run.nodeRuns?.[nodeRun.parentNodeRunId] : undefined;
  const dispatch = graphNodeDispatchInputSchema.parse(nodeRun.input);
  const nodeDef = run.agentSnapshot.nodes.find((node) => node.id === (nodeRun.prototypeNodeId || nodeRun.nodeId));
  return {
    originalRequest: buildOriginalRequest(run),
    nodeTask: dispatch.nodeTask,
    relevantContext: dispatch.relevantContext,
    contextRefs: dispatch.contextRefs,
    requirements: dispatch.requirements,
    expectedArtifacts: dispatch.expectedArtifacts,
    availableSkills: resolveNodeSkills(run.agentSnapshot, nodeDef),
    request: {
      runId: request.runId,
      mode: request.mode,
      sessionId: request.sessionId,
    },
    nodeId: nodeRun.nodeId,
    attempt: nodeRun.attempt,
    parent: parent ? {
      nodeRunId: parent.id,
      nodeId: parent.prototypeNodeId || parent.nodeId,
      status: parent.status,
      output: summarizeNodeOutput(parent.output),
      error: parent.error,
    } : undefined,
  };
}

function buildBlueprintNodePrompt(project, run, nodeDef, nodeInput) {
  const sections = [
    `你正在 Hippo 工作区「${project.name}」中执行蓝图智能体节点。`,
    `Agent Run: ${run.id}`,
    `节点: ${nodeDef.name || nodeDef.id} (${nodeDef.id})`,
    run.agentSnapshot.systemPrompt ? `Agent 全局指令：\n${run.agentSnapshot.systemPrompt}` : "",
    nodeDef.description ? `节点接口描述：\n${nodeDef.description}` : "",
    nodeDef.systemPrompt ? `节点系统提示词：\n${nodeDef.systemPrompt}` : "",
    normalizeNodeRag(nodeDef.rag).enabled
      ? `当前节点已启用 RAG 工具。可使用 hippo_rag_scope、hippo_rag_list_documents 和 hippo_rag_search，Top N 固定为 ${normalizeNodeRag(nodeDef.rag).topN}；不要默认检索。`
      : "当前节点未配置 RAG 工具。",
    `不可变的原始用户请求：\n${JSON.stringify(nodeInput.originalRequest, null, 2)}`,
    `RootAgent 分配的当前节点任务：\n${nodeInput.nodeTask}`,
    nodeInput.relevantContext !== undefined
      ? `与当前节点相关的上下文：\n${JSON.stringify(nodeInput.relevantContext, null, 2)}`
      : "RootAgent 未提供额外相关上下文。",
    nodeInput.contextRefs.length
      ? `RootAgent 授权当前节点读取的上下文引用：\n${JSON.stringify(nodeInput.contextRefs, null, 2)}\n摘要只用于定位；需要原文时调用 hippo_context_read，不要要求 Root 重复粘贴长内容。`
      : "当前节点没有获授权的上下文引用。",
    nodeInput.requirements.length
      ? `当前节点不可丢失的要求：\n${nodeInput.requirements.map((item) => `- ${item}`).join("\n")}`
      : "当前节点没有额外约束，但仍须服从原始用户请求。",
    nodeInput.expectedArtifacts.length
      ? `当前节点必须实际产出的交付物：\n${JSON.stringify(nodeInput.expectedArtifacts, null, 2)}`
      : "当前节点未声明必须生成的文件类交付物。",
    nodeInput.availableSkills.length
      ? `当前节点可使用的 Skill：\n${nodeInput.availableSkills.map(formatSkill).join("\n")}\n当节点任务要求使用其中某项能力时，必须按 $skill-name 调用，不得只输出调用方案或提示词。`
      : "当前节点未显式配置 Skill。",
    nodeInput.parent ? `触发本次执行的父 NodeRun：\n${JSON.stringify(nodeInput.parent, null, 2)}` : "当前执行没有指定父 NodeRun。",
    nodeDef.input !== undefined ? `节点静态输入：\n${JSON.stringify(nodeDef.input, null, 2)}` : "",
    "原始用户请求是不可变的目标基线；RootAgent 的节点任务只限定你负责的子任务，不能覆盖或削弱与当前节点相关的原始要求。",
    "当输出较长、需要被后续节点复用或包含完整正文时，调用 hippo_context_write 保存全文，并在最终回复中只返回简短摘要和 ctx:// 引用。不要把大段内容复制给 RootAgent。",
    "请只完成当前节点职责，并输出可供下游节点使用的结果。若声明了 expectedArtifacts，必须生成真实产物并返回可访问路径；仅返回描述、方案、提示词或占位符不算完成。",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function buildOriginalRequest(run) {
  return {
    task: run.input?.task || "",
    context: run.input?.context || {},
    attachments: (run.request?.attachments || []).map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      path: attachment.path,
      mimeType: attachment.mimeType || "",
    })),
  };
}

function buildConversationHistory(conversation, currentRunId) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  return messages
    .filter((message) => message?.text && message.runId !== currentRunId)
    .map((message) => ({
      role: message.role,
      runId: message.runId || "",
      text: String(message.text),
      attachments: normalizeStoredAttachments(message.attachments).map((attachment) => ({
        kind: attachment.kind,
        name: attachment.name,
        path: attachment.path,
        mimeType: attachment.mimeType || "",
      })),
      createdAt: message.createdAt,
    }));
}

function summarizeContextText(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
}

function formatConversationContextContent(message) {
  const attachments = message.attachments?.length
    ? `\n\n## 附件\n${message.attachments.map((item) => `- ${item.kind}: ${item.name} (${item.path})`).join("\n")}`
    : "";
  return `# ${message.role === "user" ? "用户消息" : "助手消息"}\n\n${message.text}${attachments}\n`;
}

function resolveNodeSkills(agentSnapshot, nodeDef) {
  if (!nodeDef) return [];
  return nodeDef.skills?.length ? nodeDef.skills : agentSnapshot.skills || [];
}

function collectBlueprintOutput(run) {
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
  if (output.contextRefs?.length) {
    return {
      summary: output.contextSummary || summarizeContextText(output.text || ""),
      contextRefs: output.contextRefs,
      artifacts: Array.isArray(output.artifacts) ? output.artifacts : undefined,
    };
  }
  if (typeof output.text === "string" && Array.isArray(output.artifacts) && output.artifacts.length) {
    return {
      text: output.text,
      artifacts: output.artifacts,
      recoveredAfterTimeout: output.recoveredAfterTimeout === true || undefined,
      warning: output.warning,
    };
  }
  if (typeof output.text === "string") return output.text;
  if (output.output) return output.output;
  return output;
}

function extractContextRefs(text) {
  return [...String(text || "").matchAll(/ctx:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@\d+/g)].map((match) => match[0]);
}

function stringifyBlueprintOutput(output) {
  if (!output) return "";
  if (typeof output === "string") return output;
  return output.displayText || structuredBlueprintOutputFallback(output);
}

async function buildBlueprintDisplayText({ workspace, run, output, contextStore }) {
  let primary = directBlueprintOutputText(output);
  const finalRef = output.finalContent?.ref;
  if (finalRef && run.rootSessionId && workspace.localWorkspacePath) {
    try {
      const context = await contextStore.read({
        workspacePath: workspace.localWorkspacePath,
        sessionId: run.rootSessionId,
        ref: finalRef,
        limit: 100000,
      });
      if (context.content?.trim()) primary = context.content.trim();
    } catch {
      // Keep the structured fallback if the referenced context cannot be read.
    }
  }

  const sections = [primary];
  const images = Array.isArray(output.images) ? output.images : [];
  if (images.length) {
    const imageSections = images.map((image, index) => {
      const title = String(image.title || `配图 ${index + 1}`);
      const relativePath = String(image.relativePath || "").trim();
      if (!relativePath) return `### ${title}\n\n${image.path || ""}`;
      const url = `/workspace-files/${encodeURIComponent(workspace.id)}?path=${encodeURIComponent(relativePath)}`;
      return `### ${title}\n\n![${escapeMarkdownLabel(title)}](${url})\n\n[打开原图](${url})`;
    });
    sections.push(`## 配图\n\n${imageSections.join("\n\n")}`);
  }
  if (output.publishingNote) sections.push(`> ${String(output.publishingNote)}`);
  return sections.filter(Boolean).join("\n\n").trim();
}

function directBlueprintOutputText(output) {
  if (!output || typeof output !== "object") return typeof output === "string" ? output : "";
  const candidates = [
    output.displayText,
    output.finalContent?.content,
    output.finalContent?.body,
    output.finalContent?.text,
    output.body,
    output.content,
    output.result,
    output.summary,
    output.message,
    output.text,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function structuredBlueprintOutputFallback(output) {
  const primary = directBlueprintOutputText(output);
  if (primary) return primary;
  return "任务已完成。可在执行详情中查看结构化结果。";
}

function escapeMarkdownLabel(value) {
  return String(value).replace(/[\[\]]/g, "\\$&");
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
    workspaceId: run.workspaceId,
    agentId: run.agentId || "",
    agentVersion: Number(run.agentVersion || run.agentSnapshot?.version || 1),
    agentSnapshot: snapshotAgentDefinition(run.agentSnapshot || {}),
    managed: run.managed !== false,
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
    kind: "task",
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
  if (agentSnapshot?.type !== "blueprint") return undefined;
  return {
    prototypeNodeId: value?.prototypeNodeId || agentSnapshot.rootNodeId || "root",
    status: value?.status || "pending",
    decisionCount: Math.max(0, Number(value?.decisionCount) || 0),
    noProgressCount: Math.max(0, Number(value?.noProgressCount) || 0),
    runtimeSession: value?.runtimeSession,
    runtimeRunId: value?.runtimeRunId || "",
    lastDecision: value?.lastDecision,
    updatedAt: value?.updatedAt || now,
  };
}

function normalizeNodeStatus(status) {
  return ["pending", "ready", "running", "waiting_approval", "completed", "failed", "cancelled"].includes(status)
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

function normalizeStore(store = {}) {
  return {
    version: 1,
    workspaces: normalizeWorkspaces(store.workspaces),
    agents: normalizeAgents(store.agents),
    conversations: normalizeConversations(store.conversations),
    agentRuns: normalizeAgentRuns(store.agentRuns),
  };
}

function summarizeAgentRunForList(run) {
  const nodeRuns = Object.fromEntries(Object.entries(run.nodeRuns || {}).map(([key, node]) => [key, {
    id: node.id,
    nodeId: node.nodeId,
    kind: node.kind,
    status: node.status,
    runtimeSession: node.runtimeSession?.sessionId ? { sessionId: node.runtimeSession.sessionId } : undefined,
    output: node.status === "waiting_approval" ? { text: runOutputPreview(node.output) } : undefined,
    error: node.error,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    startedAt: traceEventTimestamp(node.trace, "node_run_started"),
  }]));
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    rootSessionId: run.rootSessionId,
    agentId: run.agentId,
    status: run.status,
    managed: run.managed,
    output: run.output,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    agentSnapshot: {
      id: run.agentSnapshot?.id,
      name: run.agentSnapshot?.name,
      type: run.agentSnapshot?.type,
    },
    rootCoordinator: run.rootCoordinator ? {
      status: run.rootCoordinator.status,
      decisionCount: run.rootCoordinator.decisionCount,
      runtimeSession: run.rootCoordinator.runtimeSession?.sessionId
        ? { sessionId: run.rootCoordinator.runtimeSession.sessionId }
        : undefined,
      createdAt: run.rootCoordinator.createdAt,
      updatedAt: run.rootCoordinator.updatedAt,
      startedAt: traceEventTimestamp(run.trace, "root_coordinator_started"),
    } : undefined,
    nodeRuns,
  };
}

function traceEventTimestamp(trace, type) {
  return [...(Array.isArray(trace) ? trace : [])].reverse().find((event) => event.type === type)?.createdAt || "";
}

function runOutputPreview(output, maxLength = 100_000) {
  if (output === undefined || output === null) return "";
  const summarized = summarizeNodeOutput(output);
  const text = typeof summarized === "string" ? summarized : JSON.stringify(summarized, null, 2);
  return String(text || "").slice(0, maxLength);
}

function summarizeConversation(conversation) {
  const { messages, ...summary } = conversation;
  return {
    ...summary,
    messageCount: Array.isArray(messages) ? messages.length : 0,
  };
}

function normalizeConversation(conversation) {
  const metadata = conversation.metadata || {};
  const runtimeSessions = normalizeRuntimeSessions(conversation.runtimeSessions);
  return {
    ...conversation,
    type: conversation.type || "root",
    title: conversation.title || deriveConversationTitle(conversation.messages) || "新对话",
    messages: normalizeMessages(conversation.messages),
    activeAgentId: conversation.activeAgentId || "",
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
          forkedFromSessionId: session.forkedFromSessionId || "",
          workspacePath: session.workspacePath || "",
          hippoSessionId: session.hippoSessionId || "",
          status: session.status || (session.sessionId ? "active" : "ephemeral"),
          runtimeOptions: session.runtimeOptions && typeof session.runtimeOptions === "object"
            ? session.runtimeOptions
            : {},
          createdAt: session.createdAt || session.updatedAt || new Date().toISOString(),
          updatedAt: session.updatedAt || new Date().toISOString(),
        },
      ])
  );
}
