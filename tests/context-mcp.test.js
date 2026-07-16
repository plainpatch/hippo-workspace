import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ContextStore } from "../src/context-store.js";
import { createContextMcpServer } from "../src/mcp.js";
import { SqliteStateStore } from "../src/storage/sqlite-state-store.js";

test("Context MCP scopes Root and worker access by session and granted refs", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-context-mcp-"));
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const workspace = { id: "workspace-1", localWorkspacePath: workspacePath };
  const stateStore = new SqliteStateStore({
    databasePath: path.join(workspacePath, "metadata.sqlite3"),
    resourceRootPath: workspacePath,
  });
  stateStore.repository.saveWorkspace({ ...workspace, name: "Workspace" });
  const contextStore = new ContextStore({ repository: stateStore.repository });
  const run = { id: "run-1", rootSessionId: "session-1", agentId: "agent-1" };
  const nodeRun = { id: "node-run-1", input: { contextRefs: [] } };
  const orchestrator = {
    contextStore,
    async getWorkspace(id) {
      assert.equal(id, workspace.id);
      return { workspace };
    },
    async getNodeRun(workspaceId, runId, nodeRunId) {
      assert.equal(workspaceId, workspace.id);
      assert.equal(runId, run.id);
      assert.equal(nodeRunId, nodeRun.id);
      return { run, nodeRun };
    },
    async getAgentRun(workspaceId, runId) {
      assert.equal(workspaceId, workspace.id);
      assert.equal(runId, run.id);
      return { run };
    },
  };

  const root = await connectContextClient(createContextMcpServer({
    workspaceId: workspace.id,
    sessionId: run.rootSessionId,
    runId: run.id,
    role: "root",
    agentOrchestrator: orchestrator,
    contextStore,
  }), "root");
  t.after(() => root.close());
  const granted = parseToolResult(await root.callTool({
    name: "hippo_context_write",
    arguments: { title: "Approved input", summary: "Worker may read this", content: "authorized body", tags: ["input"] },
  }));
  const hidden = parseToolResult(await root.callTool({
    name: "hippo_context_write",
    arguments: { title: "Hidden input", summary: "Worker may not read this", content: "secret body" },
  }));
  nodeRun.input.contextRefs = [{ ref: granted.ref, title: granted.title, summary: granted.summary, reason: "task input" }];

  const worker = await connectContextClient(createContextMcpServer({
    workspaceId: workspace.id,
    sessionId: run.rootSessionId,
    runId: run.id,
    nodeRunId: nodeRun.id,
    role: "node",
    agentOrchestrator: orchestrator,
    contextStore,
  }), "worker");
  t.after(() => worker.close());
  const read = parseToolResult(await worker.callTool({
    name: "hippo_context_read",
    arguments: { ref: granted.ref, offset: 0, limit: 100, headings: [] },
  }));
  assert.equal(read.content, "authorized body");
  const denied = await worker.callTool({
    name: "hippo_context_read",
    arguments: { ref: hidden.ref, offset: 0, limit: 100, headings: [] },
  });
  assert.equal(denied.isError, true);

  const output = parseToolResult(await worker.callTool({
    name: "hippo_context_write",
    arguments: { title: "Worker output", summary: "Node result", content: "long node output", tags: ["output"] },
  }));
  assert.equal(output.source.nodeId, nodeRun.id);
  assert.equal((parseToolResult(await worker.callTool({
    name: "hippo_context_list",
    arguments: { tags: [], page: 1, pageSize: 50 },
  }))).total, 2);
  assert.equal((parseToolResult(await root.callTool({
    name: "hippo_context_read",
    arguments: { ref: output.ref, offset: 0, limit: 100, headings: [] },
  }))).content, "long node output");
});

async function connectContextClient(server, name) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: `context-${name}`, version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function parseToolResult(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
