import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextStore, ContextStoreError } from "../src/context-store.js";
import { AgentOrchestrator } from "../src/agent-orchestrator.js";
import { SqliteStateStore } from "../src/storage/sqlite-state-store.js";

test("ContextStore versions session content and supports partial reads", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-context-store-"));
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const { store } = createContextFixture(workspacePath);
  const sessionId = "session-1";

  const first = await store.write({
    workspacePath,
    sessionId,
    contextId: "post-final",
    title: "选城帖终稿",
    summary: "北上广深六维比较",
    content: "# 总览\n完整正文\n\n## 通勤\n通勤内容\n\n## 成本\n成本内容\n",
    tags: ["post", "final"],
    source: { role: "node", runId: "run-1", nodeId: "finalize" },
  });
  assert.equal(first.ref, "ctx://session-1/post-final@1");
  const selected = await store.read({ workspacePath, sessionId, ref: first.ref, headings: ["通勤"] });
  assert.match(selected.content, /通勤内容/);
  assert.doesNotMatch(selected.content, /成本内容/);

  const second = await store.write({
    workspacePath,
    sessionId,
    ref: first.ref,
    title: "选城帖终稿",
    content: "# 总览\n第二版正文\n",
    expectedVersion: 1,
    source: { role: "node", runId: "run-1", nodeId: "finalize" },
  });
  assert.equal(second.ref, "ctx://session-1/post-final@2");
  assert.match((await store.read({ workspacePath, sessionId, ref: first.ref })).content, /完整正文/);
  assert.match((await store.read({ workspacePath, sessionId, ref: second.ref })).content, /第二版正文/);
  await assert.rejects(
    store.write({ workspacePath, sessionId, ref: second.ref, title: "冲突", content: "v3", expectedVersion: 1 }),
    (error) => error instanceof ContextStoreError && error.status === 409
  );

  const listed = await store.list({ workspacePath, sessionId, tags: ["post"] });
  assert.equal(listed.total, 1);
  const searched = await store.search({ workspacePath, sessionId, query: "第二版" });
  assert.equal(searched.items[0].ref, second.ref);
});

test("ContextStore isolates sessions and preserves concurrent writes", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-context-security-"));
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const { store } = createContextFixture(workspacePath);
  const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => store.write({
    workspacePath,
    sessionId: "session-a",
    contextId: `item-${index}`,
    title: `Item ${index}`,
    content: `content ${index}`,
    source: { runId: "parallel-run", nodeId: `node-${index}` },
  })));
  assert.equal(new Set(writes.map((item) => item.ref)).size, 8);
  assert.equal((await store.list({ workspacePath, sessionId: "session-a" })).total, 8);
  const sameKey = await store.write({
    workspacePath,
    sessionId: "session-b",
    contextId: "item-0",
    title: "Same key in another session",
    content: "isolated content",
  });
  assert.equal(sameKey.ref, "ctx://session-b/item-0@1");
  assert.equal((await store.read({ workspacePath, sessionId: "session-b", ref: sameKey.ref })).content, "isolated content");
  await assert.rejects(
    store.read({ workspacePath, sessionId: "session-b", ref: writes[0].ref }),
    (error) => error instanceof ContextStoreError && error.status === 403
  );
  await assert.rejects(
    store.write({ workspacePath, sessionId: "../escape", title: "bad", content: "bad" }),
    (error) => error instanceof ContextStoreError && error.status === 400
  );
});

test("Blueprint runtime externalizes oversized worker output", async (t) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-context-output-"));
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(workspacePath, "metadata.sqlite3"),
    settings: { resourceRootPath: workspacePath },
    runtimeRegistry: {},
  });
  orchestrator.stateStore.repository.saveWorkspace({ id: "workspace", name: "Workspace", localWorkspacePath: workspacePath });
  const contextStore = orchestrator.contextStore;
  const result = await orchestrator.externalizeLongNodeResult(
    { id: "workspace", localWorkspacePath: workspacePath },
    { id: "run-1", rootSessionId: "session-1", agentId: "agent-1" },
    { id: "run-1:writer:1", nodeId: "writer" },
    { id: "writer", name: "Writer" },
    { text: `# Draft\n${"long content ".repeat(1100)}`, runtimeSession: { sessionId: "runtime" } }
  );
  assert.equal(result.contextRefs.length, 1);
  assert.ok(result.contextSummary.length <= 500);
  const stored = await contextStore.read({ workspacePath, sessionId: "session-1", ref: result.contextRefs[0].ref });
  assert.ok(stored.totalCharacters > 12000);
  assert.match(stored.content, /long content/);
});

function createContextFixture(workspacePath) {
  const stateStore = new SqliteStateStore({
    databasePath: path.join(workspacePath, "metadata.sqlite3"),
    resourceRootPath: workspacePath,
  });
  stateStore.repository.saveWorkspace({ id: "workspace", name: "Workspace", localWorkspacePath: workspacePath });
  return { stateStore, store: new ContextStore({ repository: stateStore.repository }) };
}
