import path from "node:path";
import { createHash } from "node:crypto";
import { SqliteDatabase } from "./sqlite-database.js";
import { ObjectStore } from "./object-store.js";
import { RunEventStore } from "./run-event-store.js";
import { HippoRepository } from "./hippo-repository.js";

export class SqliteStateStore {
  constructor({ databasePath, resourceRootPath }) {
    this.database = new SqliteDatabase({ databasePath });
    this.objectStore = new ObjectStore({ rootPath: path.join(resourceRootPath, "objects") });
    this.eventStore = new RunEventStore({ database: this.database, rootPath: resourceRootPath });
    this.repository = new HippoRepository({
      database: this.database,
      objectStore: this.objectStore,
      eventStore: this.eventStore,
    });
    this.signatures = {
      workspaces: new Map(),
      agents: new Map(),
      conversations: new Map(),
      runs: new Map(),
    };
    this.persistedEventIds = new Map();
    this.cache = null;
    this.dataVersion = 0;
  }

  async read() {
    const dataVersion = this.currentDataVersion();
    if (this.cache && dataVersion === this.dataVersion) return this.cache;
    const workspaces = this.repository.listWorkspaces();
    const agents = this.repository.listAgents();
    const conversations = [];
    const agentRuns = [];
    for (const workspace of workspaces) {
      for (const summary of this.repository.listConversationSummaries(workspace.id)) {
        const conversation = await this.repository.getConversation(workspace.id, summary.id);
        if (conversation) conversations.push(conversation);
      }
      const runs = await this.repository.listRuns(workspace.id, { includeEvents: true });
      for (const run of runs) {
        agentRuns.push(run);
        this.persistedEventIds.set(run.id, new Set(run.trace.map((event) => event.id)));
      }
    }
    const store = { version: 1, workspaces, agents, conversations, agentRuns };
    this.captureSignatures(store);
    this.cache = store;
    this.dataVersion = dataVersion;
    return store;
  }

  async write(store) {
    const desired = {
      workspaces: new Set((store.workspaces || []).map((item) => item.id)),
      agents: new Set((store.agents || []).map((item) => item.id)),
      conversations: new Set((store.conversations || []).map((item) => item.id)),
      runs: new Set((store.agentRuns || []).map((item) => item.id)),
    };
    this.deleteMissing(desired);

    for (const workspace of store.workspaces || []) {
      if (this.changed("workspaces", workspace.id, workspaceSignature(workspace))) {
        this.repository.saveWorkspace(workspace);
      }
    }
    for (const agent of store.agents || []) {
      if (this.changed("agents", agent.id, agentSignature(agent))) this.repository.saveAgent(agent);
    }
    for (const workspace of store.workspaces || []) {
      this.repository.replaceWorkspaceAgentRefs(workspace.id, workspace.agentIds || []);
      this.repository.replaceWorkspaceKnowledgeRefs(
        workspace.id,
        workspace.knowledgeDomainRefs || [],
        workspace.knowledgeTopicRefs || []
      );
    }
    for (const conversation of store.conversations || []) {
      if (this.changed("conversations", conversation.id, conversationSignature(conversation))) {
        await this.repository.saveConversation(conversation);
      }
    }
    for (const run of store.agentRuns || []) {
      if (!this.changed("runs", run.id, runSignature(run))) continue;
      await this.repository.saveRun(run);
      await this.appendNewEvents(run);
    }
    this.captureSignatures(store);
    this.cache = store;
    this.dataVersion = this.currentDataVersion();
  }

  close() {
    this.database.close();
  }

  currentDataVersion() {
    return this.database.db.pragma("data_version", { simple: true });
  }

  changed(group, id, signature) {
    return this.signatures[group].get(id) !== signature;
  }

  captureSignatures(store) {
    this.signatures.workspaces = new Map((store.workspaces || []).map((item) => [item.id, workspaceSignature(item)]));
    this.signatures.agents = new Map((store.agents || []).map((item) => [item.id, agentSignature(item)]));
    this.signatures.conversations = new Map((store.conversations || []).map((item) => [item.id, conversationSignature(item)]));
    this.signatures.runs = new Map((store.agentRuns || []).map((item) => [item.id, runSignature(item)]));
  }

  deleteMissing(desired) {
    const db = this.database.db;
    const transaction = db.transaction(() => {
      deleteRowsNotIn(db, "runs", desired.runs, (id) => this.persistedEventIds.delete(id));
      deleteRowsNotIn(db, "conversations", desired.conversations);
      deleteRowsNotIn(db, "agents", desired.agents);
      deleteRowsNotIn(db, "workspaces", desired.workspaces);
    });
    transaction();
  }

  async appendNewEvents(run) {
    const persisted = this.persistedEventIds.get(run.id) || new Set();
    const events = collectCanonicalEvents(run).filter((event) => !persisted.has(event.id));
    if (!events.length) return;
    const appended = await this.eventStore.append(run.id, events);
    for (const event of appended) persisted.add(event.id);
    this.persistedEventIds.set(run.id, persisted);
  }
}

function collectCanonicalEvents(run) {
  const byId = new Map();
  for (const event of run.trace || []) addEvent(byId, event, "");
  for (const node of Object.values(run.nodeRuns || {})) {
    for (const event of node.trace || []) addEvent(byId, event, node.id);
  }
  return [...byId.values()].sort((left, right) => {
    const time = String(left.createdAt || "").localeCompare(String(right.createdAt || ""));
    return time || left.order - right.order;
  }).map(({ order, ...event }) => event);
}

function addEvent(target, event, nodeRunId) {
  const id = event.id || deterministicEventId(event);
  const existing = target.get(id);
  if (existing) {
    if (!existing.nodeRunId && nodeRunId) existing.nodeRunId = nodeRunId;
    return;
  }
  target.set(id, {
    id,
    type: event.type || "runtime_event",
    payload: event.payload,
    nodeRunId: event.nodeRunId || nodeRunId || "",
    createdAt: event.createdAt || new Date().toISOString(),
    order: target.size,
  });
}

function deterministicEventId(event) {
  return `event_${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
}

function deleteRowsNotIn(db, table, desiredIds, afterDelete = () => {}) {
  const rows = db.prepare(`SELECT id FROM ${table}`).all();
  const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  for (const row of rows) {
    if (desiredIds.has(row.id)) continue;
    remove.run(row.id);
    afterDelete(row.id);
  }
}

function workspaceSignature(item) {
  return stableSignature([
    item.updatedAt, item.name, item.description, item.localWorkspacePath,
    item.hippoMcpEnabled, item.agentIds, item.knowledgeDomainRefs, item.knowledgeTopicRefs, item.metadata,
  ]);
}

function agentSignature(item) {
  return stableSignature([item.id, item.version, item.updatedAt, item]);
}

function conversationSignature(item) {
  return stableSignature([
    item.updatedAt,
    item.title,
    item.activeAgentId,
    item.messages?.length || 0,
    item.messages?.at(-1),
    item.runtimeSessions,
    item.metadata,
  ]);
}

function runSignature(run) {
  return stableSignature([
    run.updatedAt,
    run.status,
    run.output,
    run.error,
    run.rootCoordinator,
    (run.trace || []).length,
    Object.values(run.nodeRuns || {}).map((node) => [
      node.id, node.status, node.updatedAt, node.output, node.error, node.approval, (node.trace || []).length,
    ]),
  ]);
}

function stableSignature(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
