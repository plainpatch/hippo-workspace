import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteDatabase } from "../src/storage/sqlite-database.js";
import { ObjectStore } from "../src/storage/object-store.js";
import { RunEventStore } from "../src/storage/run-event-store.js";
import { HippoRepository } from "../src/storage/hippo-repository.js";

test("SQLite repository indexes metadata while message and run payloads remain in files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-storage-test-"));
  const database = new SqliteDatabase({ databasePath: path.join(root, "metadata", "hippo.sqlite3") });
  const objectStore = new ObjectStore({ rootPath: path.join(root, "objects") });
  const eventStore = new RunEventStore({ database, rootPath: root, maxSegmentBytes: 256 });
  const repository = new HippoRepository({ database, objectStore, eventStore });
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const now = new Date().toISOString();
  repository.saveWorkspace({
    id: "workspace",
    name: "Workspace",
    localWorkspacePath: path.join(root, "workspaces", "workspace"),
    localWorkspaceFolderName: "workspace",
    hippoMcpEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  repository.saveAgent({
    id: "agent",
    name: "Agent",
    type: "single",
    version: 1,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  repository.replaceWorkspaceAgentRefs("workspace", ["agent"]);

  const conversation = {
    id: "conversation",
    workspaceId: "workspace",
    title: "Large conversation",
    activeAgentId: "agent",
    messages: [
      { role: "user", text: "hello", createdAt: now },
      { role: "assistant", text: "x".repeat(20_000), runId: "run", createdAt: now },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await repository.saveConversation(conversation);
  assert.equal(repository.listConversationSummaries("workspace")[0].messageCount, 2);
  assert.equal((await repository.getConversation("workspace", "conversation")).messages[1].text.length, 20_000);
  assert.equal(database.db.prepare("SELECT COUNT(*) count FROM storage_objects").get().count, 2);

  await repository.saveRun({
    id: "run",
    workspaceId: "workspace",
    rootSessionId: "conversation",
    agentId: "agent",
    agentVersion: 1,
    status: "running",
    managed: true,
    request: { task: "hello" },
    input: { originalRequest: "hello" },
    agentSnapshot: { id: "agent", name: "Agent", type: "single" },
    nodeRuns: {
      node: {
        id: "node",
        nodeId: "root",
        status: "running",
        input: { task: "hello" },
        createdAt: now,
        updatedAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
  });
  await eventStore.append("run", [
    { type: "agent_run_started", createdAt: now },
    { type: "runtime_event", nodeRunId: "node", payload: { delta: "a".repeat(300) }, createdAt: now },
  ]);
  const run = await repository.getRun("workspace", "run", { includeEvents: true });
  assert.equal(run.trace.length, 2);
  assert.equal(run.nodeRuns.node.trace.length, 1);
  assert.equal(database.db.prepare("SELECT COUNT(*) count FROM run_event_segments").get().count, 2);
  assert.ok((await fs.readdir(path.join(root, "objects", "sha256"))).length > 0);
});

test("object storage is content addressed and rejects paths outside its root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-object-test-"));
  const store = new ObjectStore({ rootPath: root });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await store.putJson({ value: 1 });
  const second = await store.putJson({ value: 1 });
  assert.equal(first.id, second.id);
  assert.deepEqual(await store.readJson(first.path), { value: 1 });
  assert.throws(() => store.resolve("../outside"), /outside/);
});
