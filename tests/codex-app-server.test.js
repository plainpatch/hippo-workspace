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

  const captured = await adapter.stream({
    project,
    prompt: "INPUT_CAPTURE",
    rootSession: { id: "attachment-session", runtimeSessions: {} },
    runId: "run-attachments",
    attachments: [
      { kind: "image", name: "preview.png", absolutePath: "/tmp/preview.png" },
      { kind: "file", name: "spec.md", absolutePath: "/tmp/spec.md" },
      { kind: "folder", name: "source", absolutePath: "/tmp/source" },
    ],
  });
  assert.deepEqual(JSON.parse(captured.text), [
    { type: "text", text: "INPUT_CAPTURE", text_elements: [] },
    { type: "localImage", path: "/tmp/preview.png" },
    { type: "mention", name: "spec.md", path: "/tmp/spec.md" },
    { type: "mention", name: "source", path: "/tmp/source" },
  ]);

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

test("app-server adapter applies deterministic capabilities, disables stale MCP, and forks coordinator sessions", { timeout: 10000 }, async (t) => {
  const adapter = new CodexAppServerRuntimeAdapter({ command: fakeServer, model: "qa-model" });
  t.after(() => adapter.close());

  const configured = await adapter.stream({
    project,
    agent: {
      id: "qa-agent",
      systemPrompt: "Follow the QA system policy.",
      skills: [{ name: "qa-skill" }],
      mcpServers: ["hippo_context"],
    },
    prompt: "TURN_SPEC_CAPTURE",
    rootSession: { id: "capability-session", runtimeSessions: {} },
    runId: "run-capabilities",
    runtimeOptions: {
      runtimeApprovalPolicy: "never",
      sandboxMode: "read-only",
      mcpServerUrls: { hippo_context: "http://127.0.0.1/context" },
    },
  });
  const first = JSON.parse(configured.text);
  assert.match(first.developerInstructions, /Follow the QA system policy/);
  assert.equal(first.approvalPolicy, "never");
  assert.equal(first.sandbox, "read-only");
  assert.equal(first.mcpServers.hippo_context, "http://127.0.0.1/context");
  assert.ok(first.input.some((item) => item.type === "skill" && item.name === "qa-skill"));

  const cleared = await adapter.stream({
    project,
    prompt: "TURN_SPEC_CAPTURE",
    rootSession: { id: "capability-session", runtimeSessions: { codex: configured.runtimeSession } },
    runId: "run-capabilities-cleared",
    runtimeOptions: { runtimeApprovalPolicy: "inherit", mcpServerUrls: {} },
  });
  const second = JSON.parse(cleared.text);
  assert.equal(second.approvalPolicy, "on-request");
  assert.deepEqual(second.mcpServers, {});

  const forkEvents = [];
  const forked = await adapter.stream({
    project,
    prompt: "forked coordinator",
    rootSession: { id: "capability-session", runtimeSessions: { codex: cleared.runtimeSession } },
    forkSession: true,
    runId: "run-forked",
    onEvent: (event) => forkEvents.push(event),
  });
  assert.notEqual(forked.runtimeSession.sessionId, cleared.runtimeSession.sessionId);
  assert.equal(forked.runtimeSession.forkedFromSessionId, cleared.runtimeSession.sessionId);
  assert.ok(forkEvents.some((event) => event.sourceType === "thread/forked"));
});

test("app-server adapter handles host requests internally and validates Skills", { timeout: 10000 }, async (t) => {
  const adapter = new CodexAppServerRuntimeAdapter({ command: fakeServer });
  t.after(() => adapter.close());

  const dynamic = await adapter.stream({
    project,
    prompt: "DYNAMIC_TOOL",
    rootSession: { id: "dynamic-session", runtimeSessions: {} },
    runId: "run-dynamic",
    runtimeOptions: {
      dynamicTools: [{ type: "namespace", name: "hippo", description: "Hippo host tools", tools: [] }],
      dynamicToolHandler: async ({ tool, arguments: args }) => ({ tool, value: args.value }),
    },
  });
  assert.deepEqual(JSON.parse(dynamic.text), {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify({ tool: "echo", value: "ping" }) }],
  });

  const currentTime = await adapter.stream({
    project,
    prompt: "CURRENT_TIME",
    rootSession: { id: "time-session", runtimeSessions: {} },
    runId: "run-current-time",
  });
  assert.ok(Number.isInteger(JSON.parse(currentTime.text).currentTimeAt));

  const newlyInstalled = await adapter.stream({
    project,
    agent: { id: "new-skill-agent", skills: [{ name: "new-skill" }] },
    prompt: "INPUT_CAPTURE",
    rootSession: { id: "new-skill-session", runtimeSessions: {} },
    runId: "run-new-skill",
  });
  assert.ok(JSON.parse(newlyInstalled.text).some((item) => item.type === "skill" && item.name === "new-skill"));

  await assert.rejects(adapter.stream({
    project,
    agent: { id: "missing-skill-agent", skills: [{ name: "not-installed" }] },
    prompt: "should not run",
    rootSession: { id: "missing-skill-session", runtimeSessions: {} },
    runId: "run-missing-skill",
  }), (error) => error.status === 400 && error.details.missingSkills.includes("not-installed"));
});

test("app-server adapter isolates event subscriber failures from a successful turn", { timeout: 10000 }, async (t) => {
  const adapter = new CodexAppServerRuntimeAdapter({ command: fakeServer });
  t.after(() => adapter.close());
  let calls = 0;
  const result = await adapter.stream({
    project,
    prompt: "subscriber failure must not fail Codex",
    rootSession: { id: "event-error-session", runtimeSessions: {} },
    runId: "run-event-error",
    onEvent: () => {
      calls += 1;
      if (calls === 1) throw new Error("subscriber unavailable");
    },
  });
  assert.equal(result.text, "hello world");
  assert.match(result.stderr, /subscriber unavailable/);
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
