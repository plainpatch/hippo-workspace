import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentOrchestrator } from "../src/agent-orchestrator.js";

test("restart reconciliation fails managed pending/running runs but preserves manually staged graph runs", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-reconcile-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const storePath = path.join(home, "agent-store.json");
  const orchestrator = new AgentOrchestrator({
    storePath,
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  const workspace = { id: "workspace", name: "QA", agentIds: [], knowledgeDomainRefs: [], knowledgeTopicRefs: [] };
  const baseRun = {
    rootSessionId: "conversation",
    workspaceId: workspace.id,
    agentSnapshot: { type: "single", name: "General", nodes: [] },
    nodeRuns: {
      node: {
        id: "node",
        runId: "placeholder",
        nodeId: "root",
        prototypeNodeId: "root",
        status: "pending",
        trace: [],
      },
    },
    trace: [],
    createdAt: new Date().toISOString(),
  };
  await orchestrator.writeStore({
    version: 1,
    workspaces: [workspace],
    agents: [],
    conversations: [],
    agentRuns: [
      { ...baseRun, id: "managed-pending", managed: true, status: "pending" },
      { ...baseRun, id: "manual-pending", managed: false, status: "pending" },
      { ...baseRun, id: "managed-running", managed: true, status: "running" },
      { ...baseRun, id: "managed-runtime-approval", managed: true, status: "waiting_approval" },
      resultApprovalRun("managed-result-approval", "waiting_approval"),
      resultApprovalRun("restart-damaged-result-approval", "failed", true),
    ],
  });

  const result = await orchestrator.reconcileInterruptedRuns();
  const runs = (await orchestrator.listAgentRuns(workspace.id)).runs;
  assert.equal(result.interruptedRuns, 3);
  assert.equal(result.restoredRuns, 1);
  assert.equal(runs.find((run) => run.id === "managed-pending").status, "failed");
  assert.equal(runs.find((run) => run.id === "managed-pending").nodeRuns.node.status, "failed");
  assert.equal(runs.find((run) => run.id === "managed-running").error.code, "service_restarted");
  assert.equal(runs.find((run) => run.id === "managed-running").nodeRuns.node.error.code, "service_restarted");
  assert.equal(runs.find((run) => run.id === "manual-pending").status, "pending");
  assert.equal(runs.find((run) => run.id === "manual-pending").nodeRuns.node.status, "pending");
  assert.equal(runs.find((run) => run.id === "managed-runtime-approval").status, "failed");
  assert.equal(runs.find((run) => run.id === "managed-result-approval").status, "waiting_approval");
  assert.equal(runs.find((run) => run.id === "managed-result-approval").nodeRuns.approval.status, "waiting_approval");
  assert.equal(runs.find((run) => run.id === "restart-damaged-result-approval").status, "waiting_approval");
  assert.equal(runs.find((run) => run.id === "restart-damaged-result-approval").error, undefined);
});

function resultApprovalRun(id, status, damaged = false) {
  const error = damaged ? { code: "service_restarted", message: "restart" } : undefined;
  return {
    id,
    rootSessionId: "conversation",
    workspaceId: "workspace",
    managed: true,
    status,
    error,
    agentSnapshot: {
      type: "dag",
      name: "Approval DAG",
      rootNodeId: "root",
      nodes: [
        { id: "root", name: "Root", resultApprovalPolicy: "none" },
        { id: "worker", name: "Worker", resultApprovalPolicy: "manual" },
      ],
      edges: [{ from: "root", to: "worker" }],
    },
    rootCoordinator: { prototypeNodeId: "root", status: damaged ? "failed" : "ready" },
    nodeRuns: {
      approval: {
        id: "approval",
        runId: id,
        nodeId: "worker",
        prototypeNodeId: "worker",
        status: damaged ? "failed" : "waiting_approval",
        output: { text: "review me" },
        error,
        runtimeRunId: "completed-runtime-run",
        trace: [],
      },
    },
    trace: [],
    createdAt: new Date().toISOString(),
  };
}

test("conversation updates and managed run creation do not overwrite each other", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-store-lock-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    storePath: path.join(home, "agent-store.json"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  const workspace = { id: "workspace", name: "QA", agentIds: [], knowledgeDomainRefs: [], knowledgeTopicRefs: [] };
  const conversation = {
    id: "conversation",
    type: "root",
    workspaceId: workspace.id,
    title: "New",
    messages: [],
    runtimeSessions: {},
    runIds: [],
    metadata: {},
  };
  await orchestrator.writeStore({ version: 1, workspaces: [workspace], agents: [], conversations: [conversation], agentRuns: [] });

  const originalWrite = orchestrator.writeStore.bind(orchestrator);
  orchestrator.writeStore = async (store) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return originalWrite(store);
  };
  await Promise.all([
    orchestrator.updateConversation(workspace.id, conversation.id, {
      messages: [{ role: "user", text: "hello" }],
    }),
    orchestrator.updateWorkspace(workspace.id, { description: "updated while running" }),
    orchestrator.createAgentRun(
      workspace,
      conversation,
      undefined,
      { runId: "run", runtimeId: "codex", sessionId: conversation.id },
      { input: { task: "hello" } }
    ),
  ]);

  const storedConversation = (await orchestrator.getConversation(workspace.id, conversation.id)).conversation;
  const storedWorkspace = (await orchestrator.getWorkspace(workspace.id)).workspace;
  const storedRun = (await orchestrator.getAgentRun(workspace.id, "run")).run;
  assert.equal(storedConversation.messages[0].text, "hello");
  assert.deepEqual(storedConversation.runIds, ["run"]);
  assert.equal(storedWorkspace.description, "updated while running");
  assert.equal(storedRun.status, "pending");
});

test("RAG scope omits documents and document listing enforces workspace authorization", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-rag-scope-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const calls = [];
  const resourceManager = {
    knowledgeDir: path.join(home, "knowledge"),
    async getWorkspaceKnowledgeIndex(scope) {
      return {
        domains: [{
          path: "product",
          name: "Product",
          topics: [{ path: "product/api", name: "API", documents: [{ relativePath: "product/api/a.md" }] }],
        }],
        topics: [{ path: "product/api", name: "API", documents: [{ relativePath: "product/api/a.md" }] }],
      };
    },
    async listWorkspaceKnowledgeDocuments(scope, payload) {
      calls.push({ scope, payload });
      return {
        rootPath: this.knowledgeDir,
        filters: { suffixes: [".md"] },
        pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
        documents: [{ relativePath: "product/api/a.md" }],
      };
    },
  };
  const orchestrator = new AgentOrchestrator({
    storePath: path.join(home, "agent-store.json"),
    resourceManager,
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  const workspace = {
    id: "workspace",
    name: "QA",
    agentIds: [],
    knowledgeDomainRefs: ["product"],
    knowledgeTopicRefs: ["product/api"],
  };
  await orchestrator.writeStore({ version: 1, workspaces: [workspace], agents: [], conversations: [], agentRuns: [] });

  const plan = await orchestrator.getWorkspaceKnowledgePlan(workspace.id);
  assert.equal("documents" in plan.knowledge.domains[0].topics[0], false);
  assert.equal("documents" in plan.knowledge.topics[0], false);

  const listing = await orchestrator.listWorkspaceKnowledgeDocuments(workspace.id, {
    domainRefs: ["product"],
    topicRefs: ["product/api"],
    suffixes: ["md"],
    page: 1,
    pageSize: 20,
  });
  assert.equal(listing.documents[0].relativePath, "product/api/a.md");
  assert.deepEqual(calls[0].scope, { domainRefs: ["product"], topicRefs: ["product/api"], empty: false });

  const denied = await orchestrator.listWorkspaceKnowledgeDocuments(workspace.id, {
    domainRefs: ["finance"],
    topicRefs: [],
    suffixes: [],
    page: 1,
    pageSize: 20,
  });
  assert.equal(denied.scope.empty, true);
  assert.deepEqual(denied.documents, []);
  assert.equal(calls.length, 1);
});

test("RAG search results include their accessible Hippo document paths", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-rag-result-path-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const knowledgeDir = path.join(home, "knowledge");
  const resourceManager = {
    knowledgeDir,
    async getWorkspaceKnowledgeIndex() {
      const topic = {
        path: "product/api",
        name: "API",
        domainPath: "product",
        domainName: "Product",
        documents: [
          { title: "contract.md", relativePath: "product/api/contract.md" },
          { title: "guide.md", relativePath: "product/api/guide.md" },
        ],
      };
      return { domains: [{ path: "product", topics: [topic] }], topics: [topic] };
    },
    async syncTopicWorkspace() {
      return { workspaceSlug: "api", documentNames: [] };
    },
  };
  const orchestrator = new AgentOrchestrator({
    storePath: path.join(home, "agent-store.json"),
    resourceManager,
    runtimeRegistry: {},
    ragProvider: {
      async retrieve() {
        return {
          results: [{
            id: "chunk",
            text: "contract details",
            metadata: { url: "file:///anythingllm/hotdir/contract.md", title: "contract.md" },
            score: 0.9,
          }],
        };
      },
    },
    settings: {},
  });
  const workspace = {
    id: "workspace",
    name: "QA",
    agentIds: [],
    knowledgeDomainRefs: ["product"],
    knowledgeTopicRefs: ["product/api"],
  };
  await orchestrator.writeStore({ version: 1, workspaces: [workspace], agents: [], conversations: [], agentRuns: [] });

  const result = await orchestrator.searchWorkspaceKnowledge(workspace.id, {
    query: "contract",
    topicRefs: ["product/api"],
    topN: 4,
  });
  assert.equal(result.rootPath, knowledgeDir);
  assert.deepEqual(result.results[0].file, {
    rootPath: knowledgeDir,
    relativePath: "product/api/contract.md",
    path: path.join(knowledgeDir, "product", "api", "contract.md"),
  });
  assert.equal(result.unresolvedResultCount, 0);
});
