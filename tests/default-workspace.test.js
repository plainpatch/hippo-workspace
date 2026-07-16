import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentOrchestrator } from "../src/agent-orchestrator.js";

test("default workspace is created once without repurposing an existing workspace", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-default-workspace-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "agents.json"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });

  const first = await orchestrator.ensureDefaultWorkspace();
  assert.equal(first.created, true);
  assert.equal(first.workspace.name, "默认工作区");
  assert.equal(first.workspace.metadata.isDefault, true);
  assert.equal(first.workspace.hippoMcpEnabled, true);

  const repeated = await orchestrator.ensureDefaultWorkspace();
  assert.equal(repeated.created, false);
  assert.equal(repeated.workspace.id, first.workspace.id);
  assert.equal((await orchestrator.listWorkspaces()).workspaces.length, 1);

  await orchestrator.updateWorkspace(first.workspace.id, { hippoMcpEnabled: false });
  assert.equal((await orchestrator.ensureDefaultWorkspace()).workspace.hippoMcpEnabled, false);

  await orchestrator.deleteWorkspace(first.workspace.id);
  const legacy = (await orchestrator.createWorkspace({ name: "已有工作区" })).workspace;
  const recreated = await orchestrator.ensureDefaultWorkspace();
  assert.equal(recreated.created, true);
  assert.notEqual(recreated.workspace.id, legacy.id);
  assert.equal(recreated.workspace.name, "默认工作区");
  assert.equal(recreated.workspace.metadata.isDefault, true);
  assert.equal((await orchestrator.listWorkspaces()).workspaces.length, 2);
});

test("workspace MCP loading is explicit while RAG remains node-scoped", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-workspace-mcp-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "agents.json"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });

  const defaultWorkspace = (await orchestrator.ensureDefaultWorkspace()).workspace;
  const ordinaryWorkspace = (await orchestrator.createWorkspace({ name: "普通工作区" })).workspace;
  assert.equal(defaultWorkspace.hippoMcpEnabled, true);
  assert.equal(ordinaryWorkspace.hippoMcpEnabled, false);

  const defaultRequest = await orchestrator.executeAgentTask(defaultWorkspace.id, { task: "default", dryRun: true });
  assert.match(defaultRequest.request.runtimeOptions.mcpServerUrls.hippo, /\/mcp$/);

  const ordinaryRequest = await orchestrator.executeAgentTask(ordinaryWorkspace.id, { task: "ordinary", dryRun: true });
  assert.equal(ordinaryRequest.request.runtimeOptions.mcpServerUrls?.hippo, undefined);

  const ragAgent = (await orchestrator.createAgent({
    name: "RAG Agent",
    rag: { enabled: true, topN: 6 },
  })).agent;
  await orchestrator.updateWorkspace(ordinaryWorkspace.id, { agentIds: [ragAgent.id] });
  const ragRequest = await orchestrator.executeAgentTask(ordinaryWorkspace.id, {
    task: "rag",
    agentId: ragAgent.id,
    dryRun: true,
  });
  assert.equal(ragRequest.request.runtimeOptions.mcpServerUrls?.hippo, undefined);
  assert.match(ragRequest.request.runtimeOptions.mcpServerUrls.hippo_rag, /\/mcp\/rag\?/);

  await orchestrator.updateWorkspace(ordinaryWorkspace.id, { hippoMcpEnabled: true });
  const enabledRequest = await orchestrator.executeAgentTask(ordinaryWorkspace.id, { task: "enabled", dryRun: true });
  assert.match(enabledRequest.request.runtimeOptions.mcpServerUrls.hippo, /\/mcp$/);
});
