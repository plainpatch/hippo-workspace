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

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  agentIds: z.array(z.string().min(1)).default([]),
  knowledgeDrawerRefs: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  agentIds: z.array(z.string().min(1)).optional(),
  knowledgeDrawerRefs: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  createdAt: z.string().optional(),
});

const createConversationSchema = z.object({
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
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateAgentSchema = createAgentSchema.partial().extend({
  skills: z.array(skillSchema).optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
  runtimeId: z.string().min(1).optional(),
  ragDocumentNames: z.array(z.string().min(1)).optional(),
});

const executeAgentTaskSchema = z.object({
  task: z.string().min(1),
  agentId: z.string().optional(),
  mode: z.enum(["query", "chat", "automatic"]).optional(),
  sessionId: z.string().optional(),
  reset: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  knowledgeTags: z.array(z.string().min(1)).default([]),
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

  async createAgent(input) {
    const payload = createAgentSchema.parse(input);
    const store = await this.readStore();
    const now = new Date().toISOString();
    const agent = {
      id: randomUUID(),
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
    const updated = {
      ...current,
      ...definedOnly({
        name: payload.name,
        description: payload.description,
        systemPrompt: payload.systemPrompt,
        skills: payload.skills,
        mcpServers: payload.mcpServers,
        runtimeId: payload.runtimeId,
        defaultMode: payload.defaultMode,
        topN: payload.topN,
        scoreThreshold: payload.scoreThreshold,
        metadata: payload.metadata,
      }),
      explicitRagDocumentNames: dedupe(explicitDocs),
      ragDocumentNames: dedupe(explicitDocs),
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
    if (!project) throw new AgentOrchestratorError(`Project ${id} was not found.`, 404);
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
      id: randomUUID(),
      projectId,
      title: payload.title || deriveConversationTitle(payload.messages) || "新对话",
      messages: normalizeMessages(payload.messages),
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
    const updated = {
      ...current,
      ...definedOnly({
        title: payload.title || deriveConversationTitle(messages),
        messages: payload.messages ? messages : undefined,
        metadata: payload.metadata,
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

  async createProject(input) {
    const payload = createProjectSchema.parse(input);
    const store = await this.readStore();
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const projectDirectory = this.resourceManager
      ? await this.resourceManager.createProjectWorkspace({ projectId, projectName: payload.name })
      : {};
    const anythingllmWorkspaceSlug = await this.resolveAnythingllmWorkspace(payload);

    const project = {
      id: projectId,
      name: payload.name,
      description: payload.description || "",
      agentIds: dedupe(payload.agentIds),
      knowledgeDrawerRefs: dedupe(payload.knowledgeDrawerRefs.map(primaryDrawer)),
      anythingllmWorkspaceSlug,
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
    if (index === -1) throw new AgentOrchestratorError(`Project ${id} was not found.`, 404);

    const current = store.projects[index];
    const updated = {
      ...current,
      ...definedOnly({
        name: payload.name,
        description: payload.description,
        agentIds: payload.agentIds ? dedupe(payload.agentIds) : undefined,
        knowledgeDrawerRefs: payload.knowledgeDrawerRefs
          ? dedupe(payload.knowledgeDrawerRefs.map(primaryDrawer))
          : undefined,
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
      throw new AgentOrchestratorError(`Project ${id} was not found.`, 404);
    }
    store.projects = next;
    store.conversations = store.conversations.filter((conversation) => conversation.projectId !== id);
    await this.writeStore(store);
    return { deleted: true, id };
  }

  async executeAgentTask(id, input) {
    const prepared = await this.prepareAgentTask(id, input);
    const { payload, project, agent, request, retrieval } = prepared;

    if (payload.dryRun) {
      return { project, agent, request, dryRun: true };
    }

    const runtime = this.runtimeRegistry.getRuntime(request.runtimeId);
    const result = await runtime.execute({
      project,
      agent,
      prompt: request.message,
      sessionId: payload.sessionId,
      reset: payload.reset,
    });

    return { project, agent, request, retrieval, result };
  }

  async streamAgentTask(id, input, onEvent) {
    const prepared = await this.prepareAgentTask(id, input);
    const { payload, project, agent, request, retrieval } = prepared;

    onEvent?.({ type: "prepared", project, agent, request, retrieval });

    if (payload.dryRun) {
      const result = { dryRun: true, text: `已生成编排请求：\n\n${request.message}` };
      onEvent?.({ type: "done", project, agent, request, retrieval, result });
      return { project, agent, request, retrieval, result };
    }

    const runtime = this.runtimeRegistry.getRuntime(request.runtimeId);
    const result = runtime.stream
      ? await runtime.stream({
          project,
          agent,
          prompt: request.message,
          sessionId: payload.sessionId,
          reset: payload.reset,
          onEvent,
        })
      : await runtime.execute({
          project,
          agent,
          prompt: request.message,
          sessionId: payload.sessionId,
          reset: payload.reset,
        });

    onEvent?.({ type: "done", project, agent, request, retrieval, result });
    return { project, agent, request, retrieval, result };
  }

  async prepareAgentTask(id, input) {
    const payload = executeAgentTaskSchema.parse(input);
    const { project } = await this.getProject(id);
    const agent = payload.agentId ? (await this.getAgent(payload.agentId)).agent : undefined;
    if (agent && !project.agentIds?.includes(agent.id)) {
      throw new AgentOrchestratorError(
        `Agent ${agent.id} is not enabled for project ${project.id}.`,
        403
      );
    }

    const projectDocumentNames = this.resourceManager
      ? await this.resourceManager.resolveKnowledgeForProject({
          drawerRefs: project.knowledgeDrawerRefs || [],
          tags: payload.knowledgeTags,
        })
      : [];
    const ragDocumentNames = dedupe([
      ...projectDocumentNames,
      ...(agent?.explicitRagDocumentNames || agent?.ragDocumentNames || []),
    ]);

    if (ragDocumentNames.length) {
      if (this.ragProvider.updateWorkspaceEmbeddings) {
        await this.ragProvider.updateWorkspaceEmbeddings(project.anythingllmWorkspaceSlug, {
          adds: ragDocumentNames,
          deletes: [],
        });
      } else {
        await this.client.updateWorkspaceEmbeddings(project.anythingllmWorkspaceSlug, {
          adds: ragDocumentNames,
          deletes: [],
        });
      }
    }
    const mode = payload.mode || agent?.defaultMode || "chat";
    const retrieval = ragDocumentNames.length
      ? await this.retrieveRag({
          workspaceSlug: project.anythingllmWorkspaceSlug,
          query: payload.task,
          topN: agent?.topN || 4,
          scoreThreshold: agent?.scoreThreshold,
        })
      : { skipped: true, reason: "project-has-no-knowledge-drawers", results: [] };
    const message = buildAgentMessage(project, agent, payload.task, payload.context, {
      runtimeId: agent?.runtimeId || this.settings.defaultRuntimeId || config.defaultRuntimeId,
      ragDocumentNames,
      retrieval,
      knowledgeTags: payload.knowledgeTags,
    });
    const request = {
      runtimeId: agent?.runtimeId || this.settings.defaultRuntimeId || config.defaultRuntimeId,
      projectId: project.id,
      workspaceSlug: project.anythingllmWorkspaceSlug,
      mode,
      message,
      sessionId: payload.sessionId,
      reset: payload.reset,
    };
    return { payload, project, agent, request, retrieval };
  }

  async retrieveRag(payload) {
    if (this.ragProvider.retrieve) return this.ragProvider.retrieve(payload);
    return this.client.vectorSearch(payload.workspaceSlug, payload);
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
        version: 2,
        projects: normalizeProjects(store.projects || store.agentWorkspaces),
        agents: normalizeAgents(store.agents),
        conversations: normalizeConversations(store.conversations),
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 2, projects: [], agents: [], conversations: [] };
      throw error;
    }
  }

  async writeStore(store) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
  }

  findProject(store, projectId) {
    const project = store.projects.find((item) => item.id === projectId);
    if (!project) throw new AgentOrchestratorError(`Project ${projectId} was not found.`, 404);
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
    `你正在 Hippo project「${project.name}」中执行任务。`,
    project.description ? `Project 说明：\n${project.description}` : "",
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
      ? `RAG 授权边界：只能使用当前 project 引用的一级知识抽屉。AnythingLLM 仅作为检索 provider，不作为对话 runtime。`
      : "当前未加载 Agent；仍需遵守 project 的知识抽屉授权边界。",
    project.knowledgeDrawerRefs?.length
      ? `Project 可访问的一级知识抽屉：\n${project.knowledgeDrawerRefs.map((name) => `- ${name}`).join("\n")}`
      : "Project 未引用任何一级知识抽屉。",
    options.knowledgeTags?.length
      ? `本次二级 tag 过滤：\n${options.knowledgeTags.map((name) => `- ${name}`).join("\n")}`
      : "",
    options.ragDocumentNames?.length
      ? `本次可检索文档：\n${options.ragDocumentNames.map((name) => `- ${name}`).join("\n")}`
      : "本次没有可检索文档。",
    options.retrieval ? `RAG 检索结果：\n${JSON.stringify(options.retrieval, null, 2)}` : "",
    project.localWorkspacePath ? `本地项目目录：\n${project.localWorkspacePath}` : "",
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

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function definedOnly(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function primaryDrawer(value) {
  return String(value || "").replaceAll("\\", "/").split("/").filter(Boolean)[0] || "";
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) return [];
  return projects.map((project) => ({
    ...project,
    agentIds: Array.isArray(project.agentIds) ? project.agentIds : [],
    knowledgeDrawerRefs: Array.isArray(project.knowledgeDrawerRefs)
      ? dedupe(project.knowledgeDrawerRefs.map(primaryDrawer))
      : [],
  }));
}

function normalizeAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.map((agent) => {
    const { knowledgeRefs, ...current } = agent;
    return {
      ...current,
      mcpServers: Array.isArray(current.mcpServers) ? current.mcpServers : [],
      runtimeId: current.runtimeId || config.defaultRuntimeId,
      explicitRagDocumentNames: current.explicitRagDocumentNames || current.ragDocumentNames || [],
      ragDocumentNames: current.ragDocumentNames || current.explicitRagDocumentNames || [],
    };
  });
}

function normalizeConversations(conversations) {
  if (!Array.isArray(conversations)) return [];
  return conversations.map((conversation) => ({
    ...conversation,
    title: conversation.title || deriveConversationTitle(conversation.messages) || "新对话",
    messages: normalizeMessages(conversation.messages),
    metadata: conversation.metadata || {},
  }));
}
