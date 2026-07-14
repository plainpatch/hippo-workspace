import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerRuntimeAdapter } from "../src/codex-app-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(repoRoot, "tests", "fake-codex-app-server.mjs");
const project = { id: "workspace", localWorkspacePath: repoRoot };

test("app-server adapter streams turns, resumes threads, resolves approvals, and interrupts", { timeout: 10000 }, async (t) => {
  const adapter = new CodexAppServerRuntimeAdapter({ command: fakeServer, model: "qa-model" });
  t.after(() => adapter.close());

  const firstEvents = [];
  const first = await adapter.stream({
    project,
    prompt: "first",
    rootSession: { id: "hippo-session", runtimeSessions: {} },
    runId: "run-first",
    onEvent: (event) => firstEvents.push(event),
  });
  assert.equal(first.text, "hello world");
  assert.equal(first.runtimeSession.sessionId, "thread-1");
  assert.ok(firstEvents.some((event) => event.type === "stdout"));

  const resumed = await adapter.stream({
    project,
    prompt: "second",
    rootSession: { id: "hippo-session", runtimeSessions: { codex: first.runtimeSession } },
    runId: "run-second",
  });
  assert.equal(resumed.runtimeSession.sessionId, "thread-1");
  assert.equal(resumed.runtimeSession.resumedFromSessionId, "thread-1");

  let approvalEvent;
  const approvalRun = adapter.stream({
    project,
    prompt: "APPROVAL",
    rootSession: { id: "approval-session", runtimeSessions: {} },
    runId: "run-approval",
    runtimeOptions: { runtimeApprovalPolicy: "on-request" },
    onEvent: (event) => { if (event.type === "runtime_request") approvalEvent = event; },
  });
  await poll(() => approvalEvent);
  assert.equal(approvalEvent.requestType, "item/commandExecution/requestApproval");
  assert.deepEqual(adapter.resolveRequest("run-approval", approvalEvent.requestId, { decision: "accept" }), {
    resolved: true,
    runId: "run-approval",
    requestId: approvalEvent.requestId,
  });
  assert.equal((await approvalRun).text, "hello world");

  let mcpRequest;
  const mcpRun = adapter.stream({
    project,
    prompt: "MCP_FORM",
    rootSession: { id: "mcp-session", runtimeSessions: {} },
    runId: "run-mcp-form",
    onEvent: (event) => { if (event.type === "runtime_request") mcpRequest = event; },
  });
  await poll(() => mcpRequest);
  assert.equal(mcpRequest.requestType, "mcpServer/elicitation/request");
  assert.equal(mcpRequest.params.requestedSchema.properties.retries.type, "integer");
  assert.equal(adapter.resolveRequest("run-mcp-form", mcpRequest.requestId, {
    action: "accept",
    content: { environment: "staging", retries: 2 },
    _meta: null,
  }).resolved, true);
  assert.equal((await mcpRun).text, "hello world");

  const streamTimes = [];
  const markdown = await adapter.stream({
    project,
    prompt: "STREAM_MARKDOWN",
    rootSession: { id: "stream-session", runtimeSessions: {} },
    runId: "run-stream-markdown",
    onEvent: (event) => {
      if (event.type === "stdout") streamTimes.push(Date.now());
    },
  });
  assert.match(markdown.text, /```javascript/);
  assert.ok(streamTimes.length >= 2);
  assert.ok(streamTimes.at(-1) - streamTimes[0] >= 350, `Expected delayed chunks, received ${streamTimes}`);

  let steerStarted = false;
  const steeredRun = adapter.stream({
    project,
    prompt: "BLOCK",
    rootSession: { id: "steer-session", runtimeSessions: {} },
    runId: "run-steer",
    onEvent: (event) => { if (event.eventType === "turn_started") steerStarted = true; },
  });
  await poll(() => steerStarted);
  assert.equal((await adapter.steer("run-steer", "updated direction")).steered, true);
  assert.equal((await steeredRun).text, "hello world");

  let blockStarted = false;
  const blocked = adapter.stream({
    project,
    prompt: "BLOCK",
    rootSession: { id: "block-session", runtimeSessions: {} },
    runId: "run-block",
    onEvent: (event) => { if (event.eventType === "turn_started") blockStarted = true; },
  });
  await poll(() => blockStarted);
  assert.equal(adapter.cancel("run-block").cancelled, true);
  await assert.rejects(blocked, (error) => error.status === 499 && error.details.cancelled);

  adapter.child.kill("SIGTERM");
  await poll(() => adapter.child === null);
  const afterRestart = await adapter.stream({
    project,
    prompt: "after app-server restart",
    rootSession: { id: "restart-session", runtimeSessions: {} },
    runId: "run-after-restart",
  });
  assert.equal(afterRestart.text, "hello world");
  assert.equal(afterRestart.runtimeSession.sessionId, "thread-1");
});

async function poll(operation) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = operation();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake app-server event.");
}
