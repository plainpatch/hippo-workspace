import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentOrchestrator } from "../src/agent-orchestrator.js";

test("concurrent graph advances share one coordinator execution", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-graph-lease-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "hippo.sqlite3"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  let calls = 0;
  orchestrator.runGraphCoordinator = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { run: { id: "run", status: "completed" } };
  };
  const args = [{ id: "workspace" }, { executionPolicy: {} }, {}, "run"];
  const [first, second] = await Promise.all([
    orchestrator.coordinateGraphRun(...args),
    orchestrator.coordinateGraphRun(...args),
  ]);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);
  assert.equal(orchestrator.graphRunExecutions.size, 0);
});

test("a Blueprint run cannot complete while a worker remains active", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-terminal-guard-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "hippo.sqlite3"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  await orchestrator.writeStore({
    version: 1,
    workspaces: [{ id: "workspace", name: "QA", agentIds: [], knowledgeDomainRefs: [], knowledgeTopicRefs: [] }],
    agents: [],
    conversations: [],
    agentRuns: [{
      id: "run",
      workspaceId: "workspace",
      status: "running",
      agentSnapshot: { type: "blueprint", rootNodeId: "root", nodes: [{ id: "root" }, { id: "worker" }], edges: [] },
      rootCoordinator: { status: "running" },
      nodeRuns: {
        root: { id: "root-run", nodeId: "root", prototypeNodeId: "root", status: "pending", trace: [] },
        worker: { id: "worker-run", nodeId: "worker", prototypeNodeId: "worker", status: "running", runtimeRunId: "runtime-worker", trace: [] },
      },
      trace: [],
    }],
  });
  await assert.rejects(
    orchestrator.completeBlueprintRun("workspace", "run", { status: "completed", output: { text: "too early" } }),
    (error) => error.status === 409 && error.details.activeNodeRunIds.includes("worker-run")
  );
  assert.equal((await orchestrator.getAgentRun("workspace", "run")).run.status, "running");
});

test("deleting a conversation deletes its persisted Codex sessions", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-thread-delete-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const deleted = [];
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "hippo.sqlite3"),
    runtimeRegistry: { deleteSession: async (session) => deleted.push(session.sessionId) },
    ragProvider: {},
    settings: {},
  });
  await orchestrator.writeStore({
    version: 1,
    workspaces: [{ id: "workspace", name: "QA", localWorkspacePath: home, agentIds: [], knowledgeDomainRefs: [], knowledgeTopicRefs: [] }],
    agents: [],
    conversations: [{
      id: "conversation",
      workspaceId: "workspace",
      title: "Delete me",
      messages: [],
      runtimeSessions: { codex: { provider: "codex", sessionId: "thread-conversation", runtimeOptions: { mcpServerUrls: { hippo: "http://127.0.0.1/mcp" } } } },
      metadata: {},
    }],
    agentRuns: [{
      id: "run",
      workspaceId: "workspace",
      rootSessionId: "conversation",
      status: "completed",
      agentSnapshot: { id: "agent", name: "Agent", type: "blueprint" },
      rootCoordinator: { runtimeSession: { provider: "codex", sessionId: "thread-root" } },
      nodeRuns: { worker: { id: "worker", nodeId: "worker", status: "completed", runtimeSession: { provider: "codex", sessionId: "thread-worker" } } },
      trace: [],
    }],
  });
  const stored = (await orchestrator.getConversation("workspace", "conversation")).conversation;
  assert.equal(stored.runtimeSessions.codex.runtimeOptions.mcpServerUrls.hippo, "http://127.0.0.1/mcp");
  await orchestrator.deleteConversation("workspace", "conversation");
  assert.deepEqual(deleted.sort(), ["thread-conversation", "thread-root", "thread-worker"]);
});

test("conversation summaries omit message payloads used only by the active conversation", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-conversation-summary-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "agent-store.json"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  const workspace = { id: "workspace", name: "QA", agentIds: [], knowledgeDomainRefs: [], knowledgeTopicRefs: [] };
  const conversation = {
    id: "conversation",
    type: "root",
    workspaceId: workspace.id,
    title: "Large history",
    messages: [{ role: "assistant", text: "x".repeat(10_000) }],
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await orchestrator.writeStore({
    version: 1,
    workspaces: [workspace],
    agents: [],
    conversations: [conversation],
    agentRuns: [{
      id: "run",
      workspaceId: workspace.id,
      rootSessionId: conversation.id,
      status: "waiting_approval",
      agentSnapshot: { id: "agent", name: "QA Agent", type: "blueprint" },
      trace: [{ type: "root_coordinator_started", payload: { large: "x".repeat(10_000) }, createdAt: "2026-01-01T00:00:01.000Z" }],
      nodeRuns: {
        node: {
          id: "node",
          nodeId: "writer",
          status: "waiting_approval",
          output: { text: "review this" },
          trace: [{ type: "node_run_started", payload: { large: "x".repeat(10_000) }, createdAt: "2026-01-01T00:00:02.000Z" }],
        },
      },
    }],
  });

  const full = (await orchestrator.listConversations(workspace.id)).conversations[0];
  const summary = (await orchestrator.listConversations(workspace.id, { summary: true })).conversations[0];
  assert.equal(full.messages[0].text.length, 10_000);
  assert.equal(summary.messages, undefined);
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.title, conversation.title);
  const fullRun = (await orchestrator.listAgentRuns(workspace.id)).runs[0];
  const runSummary = (await orchestrator.listAgentRuns(workspace.id, { summary: true })).runs[0];
  assert.equal(fullRun.trace[0].payload.large.length, 10_000);
  assert.equal(runSummary.trace, undefined);
  assert.equal(runSummary.agentSnapshot.systemPrompt, undefined);
  assert.equal(runSummary.nodeRuns.node.trace, undefined);
  assert.equal(runSummary.nodeRuns.node.output.text, "review this");
  assert.equal(runSummary.nodeRuns.node.startedAt, "2026-01-01T00:00:02.000Z");
});

test("Blueprint nodes complete as soon as expected image artifacts are stable", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-artifact-recovery-test-"));
  const workspacePath = path.join(home, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  let rejectRuntime;
  const artifactRuntime = {
    stream: async () => {
      const outputDirectory = path.join(workspacePath, "assets");
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.writeFile(path.join(outputDirectory, "cover.png"), "cover-image");
      await fs.writeFile(path.join(outputDirectory, "detail.png"), "detail-image");
      return new Promise((resolve, reject) => { rejectRuntime = reject; });
    },
  };
  const runtimeRegistry = {
    getRuntime: () => artifactRuntime,
    cancelRun: () => {
      const error = new Error("Runtime run was cancelled after expected artifacts completed.");
      error.status = 499;
      error.details = { cancelled: true };
      rejectRuntime?.(error);
      return { cancelled: true };
    },
  };
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "hippo.sqlite3"),
    runtimeRegistry,
    ragProvider: {},
    settings: {},
  });
  const workspace = {
    id: "workspace",
    name: "QA",
    localWorkspacePath: workspacePath,
    agentIds: ["agent"],
    knowledgeDomainRefs: [],
    knowledgeTopicRefs: [],
  };
  const input = {
    nodeTask: "生成两张配图",
    relevantContext: {},
    contextRefs: [],
    requirements: [],
    expectedArtifacts: [{ type: "image", count: 2, description: "两张 PNG 配图" }],
  };
  const agent = {
    id: "agent",
    name: "Image Agent",
    type: "blueprint",
    runtimeId: "codex",
    rootNodeId: "root",
    nodes: [
      { id: "root", name: "Root", kind: "task", runtimeId: "codex" },
      { id: "visual", name: "Visual", kind: "task", runtimeId: "codex", resultApprovalPolicy: "none" },
    ],
    edges: [{ from: "root", to: "visual" }],
  };
  const nodeRunId = "run:visual:1";
  await orchestrator.writeStore({
    version: 1,
    workspaces: [workspace],
    agents: [agent],
    conversations: [{
      id: "conversation",
      type: "root",
      workspaceId: workspace.id,
      title: "Image task",
      messages: [],
      runtimeSessions: {},
      runIds: ["run"],
      metadata: {},
    }],
    agentRuns: [{
      id: "run",
      workspaceId: workspace.id,
      rootSessionId: "conversation",
      agentId: agent.id,
      agentSnapshot: agent,
      status: "running",
      request: { runtimeId: "codex", runtimeOptions: {}, attachments: [] },
      rootCoordinator: { prototypeNodeId: "root", status: "ready", decisionCount: 1 },
      nodeRuns: {
        [nodeRunId]: {
          id: nodeRunId,
          runId: "run",
          nodeId: "visual",
          prototypeNodeId: "visual",
          attempt: 1,
          status: "ready",
          input,
          trace: [],
        },
      },
      trace: [],
    }],
  });

  const startedAt = Date.now();
  await orchestrator.executeBlueprintNode(workspace, agent, {
    runtimeId: "codex",
    runtimeOptions: {},
    attachments: [],
    task: "生成两张配图",
  }, "run", nodeRunId);

  const stored = (await orchestrator.getNodeRun(workspace.id, "run", nodeRunId)).nodeRun;
  assert.equal(stored.status, "completed");
  assert.equal(stored.output.completedFromArtifacts, true);
  assert.equal(stored.output.recoveredAfterTimeout, false);
  assert.ok(Date.now() - startedAt < 4000, "node should not wait for the runtime timeout");
  assert.deepEqual(stored.output.artifacts.map((item) => item.relativePath), ["assets/cover.png", "assets/detail.png"]);
  const indexed = orchestrator.stateStore.repository.listArtifacts(workspace.id, { runId: "run" });
  assert.equal(indexed.length, 2);
  assert.ok(indexed.every((item) => item.artifactType === "image"));
});

test("Blueprint completion renders referenced content and workspace images instead of JSON", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-blueprint-display-test-"));
  const workspacePath = path.join(home, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "hippo.sqlite3"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: { resourceRootPath: home },
  });
  const workspace = {
    id: "workspace",
    name: "QA",
    localWorkspacePath: workspacePath,
    agentIds: ["agent"],
    knowledgeDomainRefs: [],
    knowledgeTopicRefs: [],
  };
  const agent = {
    id: "agent",
    name: "Writer",
    type: "blueprint",
    rootNodeId: "root",
    nodes: [{ id: "root", name: "Root", kind: "task" }],
    edges: [],
  };
  await orchestrator.writeStore({
    version: 1,
    workspaces: [workspace],
    agents: [agent],
    conversations: [{
      id: "conversation",
      type: "root",
      workspaceId: workspace.id,
      title: "Display",
      messages: [],
      runtimeSessions: {},
      runIds: ["run"],
      metadata: {},
    }],
    agentRuns: [{
      id: "run",
      workspaceId: workspace.id,
      rootSessionId: "conversation",
      agentId: agent.id,
      agentSnapshot: agent,
      status: "coordinating",
      rootCoordinator: { prototypeNodeId: "root", status: "ready", decisionCount: 1 },
      nodeRuns: {},
      trace: [],
    }],
  });
  const context = await orchestrator.contextStore.write({
    workspacePath,
    sessionId: "conversation",
    title: "Final article",
    content: "# 最终正文\n\n这是可直接展示的内容。",
  });

  const completed = await orchestrator.completeGraphRun(workspace.id, "run", {
    output: {
      status: "completed",
      summary: "完成",
      finalContent: { ref: context.ref },
      images: [{ title: "配图一", relativePath: "assets/final.png", path: path.join(workspacePath, "assets/final.png") }],
    },
  });

  assert.match(completed.run.output.displayText, /^# 最终正文/);
  assert.match(completed.run.output.displayText, /!\[配图一\]\(\/workspace-files\/workspace\?path=assets%2Ffinal\.png\)/);
  assert.doesNotMatch(completed.run.output.displayText, /^\s*\{/);
});

test("restart reconciliation fails managed pending/running runs but preserves manually staged graph runs", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-reconcile-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const databasePath = path.join(home, "hippo.sqlite3");
  const orchestrator = new AgentOrchestrator({
    databasePath,
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
      type: "blueprint",
      name: "Approval Blueprint",
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
    databasePath: path.join(home, "agent-store.json"),
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

test("editing and resending branches a conversation and clears later runtime state", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-conversation-branch-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const deletedSessions = [];
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "agent-store.json"),
    runtimeRegistry: { deleteSession: async (session) => deletedSessions.push(session.sessionId) },
    ragProvider: {},
    settings: {},
  });
  const workspace = { id: "workspace", name: "QA", agentIds: [], knowledgeDomainRefs: [], knowledgeTopicRefs: [] };
  const conversation = {
    id: "conversation",
    type: "root",
    workspaceId: workspace.id,
    title: "First",
    messages: [
      { role: "user", text: "first", runId: "run-1" },
      { role: "assistant", text: "first answer", runId: "run-1" },
      { role: "user", text: "second", runId: "run-2" },
      { role: "assistant", text: "second answer", runId: "run-2" },
    ],
    runtimeSessions: { codex: { provider: "codex", sessionId: "old-codex-session" } },
    runIds: ["run-1", "run-2"],
    metadata: { runtimeSessions: { codex: { provider: "codex", sessionId: "old-codex-session" } } },
  };
  const makeRun = (id) => ({
    id,
    workspaceId: workspace.id,
    rootSessionId: conversation.id,
    status: "completed",
    nodeRuns: {},
    trace: [],
  });
  await orchestrator.writeStore({
    version: 1,
    workspaces: [workspace],
    agents: [],
    conversations: [conversation],
    agentRuns: [makeRun("run-1"), makeRun("run-2")],
  });

  const branched = (await orchestrator.branchConversation(workspace.id, conversation.id, { messageIndex: 2 })).conversation;
  assert.deepEqual(branched.messages.map((message) => message.text), ["first", "first answer"]);
  assert.deepEqual(branched.runtimeSessions, {});
  assert.deepEqual(branched.metadata.runtimeSessions, {});
  assert.deepEqual(branched.runIds, ["run-1"]);
  assert.deepEqual(deletedSessions, ["old-codex-session"]);
  assert.deepEqual((await orchestrator.listAgentRuns(workspace.id)).runs.map((run) => run.id), ["run-1"]);
  await assert.rejects(
    orchestrator.branchConversation(workspace.id, conversation.id, { messageIndex: 1 }),
    /Only an existing user message/
  );
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
    databasePath: path.join(home, "agent-store.json"),
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
    databasePath: path.join(home, "agent-store.json"),
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
