import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
});

const createAgentWorkspaceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(skillSchema).default([]),
  anythingllmWorkspaceSlug: z.string().min(1).optional(),
  anythingllmWorkspaceName: z.string().min(1).optional(),
  createAnythingllmWorkspace: z.boolean().default(true),
  ragDocumentNames: z.array(z.string().min(1)).default([]),
  defaultMode: z.enum(["query", "chat", "automatic"]).default("query"),
  topN: z.number().int().positive().default(4),
  scoreThreshold: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateAgentWorkspaceSchema = createAgentWorkspaceSchema.partial().extend({
  skills: z.array(skillSchema).optional(),
  ragDocumentNames: z.array(z.string().min(1)).optional(),
});

const executeAgentTaskSchema = z.object({
  task: z.string().min(1),
  mode: z.enum(["query", "chat", "automatic"]).optional(),
  sessionId: z.string().optional(),
  reset: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const updateRagScopeSchema = z.object({
  adds: z.array(z.string().min(1)).default([]),
  deletes: z.array(z.string().min(1)).default([]),
});

export class AgentOrchestrator {
  constructor({ client, storePath = config.agentStorePath }) {
    this.client = client;
    this.storePath = storePath;
  }

  async listAgentWorkspaces() {
    const store = await this.readStore();
    return { agentWorkspaces: store.agentWorkspaces };
  }

  async getAgentWorkspace(id) {
    const store = await this.readStore();
    const workspace = store.agentWorkspaces.find((item) => item.id === id);
    if (!workspace) throw new AgentOrchestratorError(`Agent workspace ${id} was not found.`, 404);
    return { agentWorkspace: workspace };
  }

  async createAgentWorkspace(input) {
    const payload = createAgentWorkspaceSchema.parse(input);
    const store = await this.readStore();
    const now = new Date().toISOString();
    const anythingllmWorkspaceSlug = await this.resolveAnythingllmWorkspace(payload);

    if (payload.ragDocumentNames.length) {
      await this.client.updateWorkspaceEmbeddings(anythingllmWorkspaceSlug, {
        adds: payload.ragDocumentNames,
        deletes: [],
      });
    }

    const agentWorkspace = {
      id: randomUUID(),
      name: payload.name,
      description: payload.description || "",
      systemPrompt: payload.systemPrompt || "",
      skills: payload.skills,
      anythingllmWorkspaceSlug,
      ragDocumentNames: dedupe(payload.ragDocumentNames),
      defaultMode: payload.defaultMode,
      topN: payload.topN,
      scoreThreshold: payload.scoreThreshold,
      metadata: payload.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    store.agentWorkspaces.push(agentWorkspace);
    await this.writeStore(store);
    return { agentWorkspace };
  }

  async updateAgentWorkspace(id, input) {
    const payload = updateAgentWorkspaceSchema.parse(input);
    const store = await this.readStore();
    const index = store.agentWorkspaces.findIndex((item) => item.id === id);
    if (index === -1) throw new AgentOrchestratorError(`Agent workspace ${id} was not found.`, 404);

    const current = store.agentWorkspaces[index];
    const updated = {
      ...current,
      ...definedOnly({
        name: payload.name,
        description: payload.description,
        systemPrompt: payload.systemPrompt,
        skills: payload.skills,
        anythingllmWorkspaceSlug: payload.anythingllmWorkspaceSlug,
        defaultMode: payload.defaultMode,
        topN: payload.topN,
        scoreThreshold: payload.scoreThreshold,
        metadata: payload.metadata,
      }),
      updatedAt: new Date().toISOString(),
    };

    if (payload.ragDocumentNames) {
      updated.ragDocumentNames = dedupe(payload.ragDocumentNames);
    }

    store.agentWorkspaces[index] = updated;
    await this.writeStore(store);
    return { agentWorkspace: updated };
  }

  async deleteAgentWorkspace(id) {
    const store = await this.readStore();
    const next = store.agentWorkspaces.filter((item) => item.id !== id);
    if (next.length === store.agentWorkspaces.length) {
      throw new AgentOrchestratorError(`Agent workspace ${id} was not found.`, 404);
    }
    store.agentWorkspaces = next;
    await this.writeStore(store);
    return { deleted: true, id };
  }

  async updateRagScope(id, input) {
    const payload = updateRagScopeSchema.parse(input);
    const store = await this.readStore();
    const index = store.agentWorkspaces.findIndex((item) => item.id === id);
    if (index === -1) throw new AgentOrchestratorError(`Agent workspace ${id} was not found.`, 404);

    const current = store.agentWorkspaces[index];
    await this.client.updateWorkspaceEmbeddings(current.anythingllmWorkspaceSlug, payload);

    const deletes = new Set(payload.deletes);
    const ragDocumentNames = dedupe([
      ...current.ragDocumentNames.filter((name) => !deletes.has(name)),
      ...payload.adds,
    ]);
    const updated = {
      ...current,
      ragDocumentNames,
      updatedAt: new Date().toISOString(),
    };
    store.agentWorkspaces[index] = updated;
    await this.writeStore(store);
    return { agentWorkspace: updated };
  }

  async executeAgentTask(id, input) {
    const payload = executeAgentTaskSchema.parse(input);
    const { agentWorkspace } = await this.getAgentWorkspace(id);
    const mode = payload.mode || agentWorkspace.defaultMode || "query";
    const message = buildAgentMessage(agentWorkspace, payload.task, payload.context);
    const request = {
      workspaceSlug: agentWorkspace.anythingllmWorkspaceSlug,
      mode,
      message,
      sessionId: payload.sessionId,
      reset: payload.reset,
    };

    if (payload.dryRun) {
      return { agentWorkspace, request, dryRun: true };
    }

    const result = await this.client.workspaceChat(agentWorkspace.anythingllmWorkspaceSlug, {
      message,
      mode,
      sessionId: payload.sessionId,
      reset: payload.reset,
    });

    return { agentWorkspace, request, result };
  }

  async resolveAnythingllmWorkspace(payload) {
    if (payload.anythingllmWorkspaceSlug) return payload.anythingllmWorkspaceSlug;
    if (!payload.createAnythingllmWorkspace) {
      throw new AgentOrchestratorError(
        "anythingllmWorkspaceSlug is required when createAnythingllmWorkspace is false.",
        400
      );
    }

    const workspaceName = payload.anythingllmWorkspaceName || payload.name;
    const response = await this.client.createWorkspace({
      name: workspaceName,
      chatMode: payload.defaultMode === "chat" ? "chat" : "query",
      topN: payload.topN,
      similarityThreshold: payload.scoreThreshold,
      openAiPrompt: payload.systemPrompt,
    });
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
        version: 1,
        agentWorkspaces: Array.isArray(store.agentWorkspaces) ? store.agentWorkspaces : [],
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, agentWorkspaces: [] };
      throw error;
    }
  }

  async writeStore(store) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
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

export function buildAgentMessage(agentWorkspace, task, context = undefined) {
  const sections = [
    `你正在以定制智能体「${agentWorkspace.name}」的身份执行任务。`,
    agentWorkspace.description ? `智能体说明：\n${agentWorkspace.description}` : "",
    agentWorkspace.systemPrompt ? `系统指令：\n${agentWorkspace.systemPrompt}` : "",
    agentWorkspace.skills.length
      ? `允许使用的技能：\n${agentWorkspace.skills.map(formatSkill).join("\n")}`
      : "允许使用的技能：未显式配置。",
    `RAG 边界：只能把绑定的 AnythingLLM 工作空间「${agentWorkspace.anythingllmWorkspaceSlug}」作为知识范围。`,
    agentWorkspace.ragDocumentNames.length
      ? `配置的文档范围：\n${agentWorkspace.ragDocumentNames.map((name) => `- ${name}`).join("\n")}`
      : "配置的文档范围：绑定工作空间内当前已索引的全部文档。",
    context ? `运行时上下文：\n${JSON.stringify(context, null, 2)}` : "",
    `任务：\n${task}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function agentSchemas() {
  return {
    createAgentWorkspaceSchema,
    updateAgentWorkspaceSchema,
    executeAgentTaskSchema,
    updateRagScopeSchema,
  };
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
