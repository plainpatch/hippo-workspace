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
    ],
  });

  const result = await orchestrator.reconcileInterruptedRuns();
  const runs = (await orchestrator.listAgentRuns(workspace.id)).runs;
  assert.equal(result.interruptedRuns, 2);
  assert.equal(runs.find((run) => run.id === "managed-pending").status, "failed");
  assert.equal(runs.find((run) => run.id === "managed-pending").nodeRuns.node.status, "failed");
  assert.equal(runs.find((run) => run.id === "managed-running").error.code, "service_restarted");
  assert.equal(runs.find((run) => run.id === "managed-running").nodeRuns.node.error.code, "service_restarted");
  assert.equal(runs.find((run) => run.id === "manual-pending").status, "pending");
  assert.equal(runs.find((run) => run.id === "manual-pending").nodeRuns.node.status, "pending");
});

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
