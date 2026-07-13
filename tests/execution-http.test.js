import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodexPath = path.join(repoRoot, "tests", "fake-codex.mjs");
const fakeAppServerPath = path.join(repoRoot, "tests", "fake-codex-app-server.mjs");

test("HTTP execution survives disconnect, resumes sessions, cancels, and reconciles restart", { timeout: 30000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-execution-test-"));
  const logPath = path.join(home, "fake-codex.jsonl");
  const port = await getFreePort();
  let server = await startServer({ home, logPath, port });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(home, { recursive: true, force: true });
  });

  const workspace = (await jsonRequest(port, "/api/workspaces", {
    method: "POST",
    body: { name: "Execution QA" },
  })).workspace;
  const conversation = (await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations`, {
    method: "POST",
    body: { title: "Primary", messages: [] },
  })).conversation;

  const firstRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const firstResponse = await startExecution(port, workspace.id, {
    task: "SLOW reconnect",
    sessionId: conversation.id,
    runId: firstRunId,
  });
  const initial = await readEvents(
    firstResponse.body,
    (events) => events.some((event) => event.type === "runtime_event" && event.eventType === "runtime_session_started"),
    { cancel: false }
  );
  assert.ok(initial.events.some((event) => event.type === "prepared"), JSON.stringify(initial.events));
  await initial.reader.cancel();

  const mappedConversation = await poll(async () => {
    const value = await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations/${conversation.id}`);
    return value.conversation.runtimeSessions?.codex?.sessionId ? value.conversation : undefined;
  });
  assert.equal(mappedConversation.runtimeSessions.codex.sessionId, "11111111-1111-4111-8111-111111111111");

  const completedFirst = await poll(async () => {
    const value = await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${firstRunId}`);
    return value.run.status === "completed" ? value.run : undefined;
  });
  assert.match(completedFirst.output.text, /SLOW reconnect/);

  const replayResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runs/${firstRunId}/events?after=1`);
  const replay = await readEvents(replayResponse.body, (events) => events.some(isTerminalEvent));
  assert.ok(replay.events.every((event) => !event.sequence || event.sequence > 1));
  assert.ok(replay.events.some((event) => event.type === "done"));

  const secondRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const secondResponse = await startExecution(port, workspace.id, {
    task: "resume this conversation",
    sessionId: conversation.id,
    runId: secondRunId,
  });
  await readEvents(secondResponse.body, (events) => events.some(isTerminalEvent));
  const invocations = await readLog(logPath);
  assert.equal(invocations[1].resumedSessionId, "11111111-1111-4111-8111-111111111111");

  const otherConversation = (await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations`, {
    method: "POST",
    body: { title: "Independent", messages: [] },
  })).conversation;
  const thirdResponse = await startExecution(port, workspace.id, {
    task: "new conversation",
    sessionId: otherConversation.id,
    runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  await readEvents(thirdResponse.body, (events) => events.some(isTerminalEvent));
  assert.equal((await readLog(logPath))[2].resumedSessionId, "");

  const cancelRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const cancelResponse = await startExecution(port, workspace.id, {
    task: "BLOCK cancel",
    sessionId: conversation.id,
    runId: cancelRunId,
  });
  const cancelStream = readEvents(cancelResponse.body, (events) => events.some(isTerminalEvent));
  await poll(async () => {
    const value = await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${cancelRunId}`);
    return value.run.status === "running" ? true : undefined;
  });
  await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${cancelRunId}/cancel`, { method: "POST" });
  const cancelledEvents = await cancelStream;
  assert.ok(cancelledEvents.events.some((event) => event.type === "cancelled"));
  assert.equal((await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${cancelRunId}`)).run.status, "cancelled");

  const restartRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const restartResponse = await startExecution(port, workspace.id, {
    task: "BLOCK restart",
    sessionId: conversation.id,
    runId: restartRunId,
  });
  await readEvents(restartResponse.body, (events) => events.some((event) => event.type === "prepared"), { cancel: false });
  await poll(async () => {
    const value = await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${restartRunId}`);
    return value.run.status === "running" ? true : undefined;
  });
  await stopServer(server);
  server = await startServer({ home, logPath, port });
  const interrupted = await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${restartRunId}`);
  assert.equal(interrupted.run.status, "failed");
  assert.equal(interrupted.run.error.code, "service_restarted");
});

test("HTTP app-server approvals survive UI disconnect and resume after a decision", { timeout: 15000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-approval-test-"));
  const port = await getFreePort();
  const server = await startServer({
    home,
    logPath: path.join(home, "unused.log"),
    port,
    command: fakeAppServerPath,
    transport: "app-server",
  });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(home, { recursive: true, force: true });
  });
  const workspace = (await jsonRequest(port, "/api/workspaces", { method: "POST", body: { name: "Approval QA" } })).workspace;
  const conversation = (await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations`, {
    method: "POST",
    body: { title: "Approval", messages: [] },
  })).conversation;
  const runId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const response = await startExecution(port, workspace.id, {
    task: "APPROVAL",
    sessionId: conversation.id,
    runId,
  });
  const waiting = await readEvents(response.body, (events) => events.some((event) => event.type === "runtime_request"), { cancel: false });
  const approval = waiting.events.find((event) => event.type === "runtime_request");
  await waiting.reader.cancel();
  const storedWaiting = await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${runId}`);
  assert.equal(storedWaiting.run.status, "waiting_approval");

  const resolution = await jsonRequest(port, `/api/runtime-runs/${runId}/requests/${approval.requestId}/resolve`, {
    method: "POST",
    body: { result: { decision: "accept" } },
  });
  assert.equal(resolution.resolved, true);
  const resumed = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runs/${runId}/events?after=${approval.sequence}`);
  const completion = await readEvents(resumed.body, (events) => events.some(isTerminalEvent));
  assert.ok(completion.events.some((event) => event.type === "runtime_request_resolved"));
  assert.ok(completion.events.some((event) => event.type === "done"));
  assert.equal((await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${runId}`)).run.status, "completed");

  const steerRunId = "99999999-9999-4999-8999-999999999999";
  const steerResponse = await startExecution(port, workspace.id, {
    task: "BLOCK",
    sessionId: conversation.id,
    runId: steerRunId,
  });
  const steering = await readEvents(
    steerResponse.body,
    (events) => events.some((event) => event.type === "runtime_event" && event.eventType === "turn_started"),
    { cancel: false }
  );
  await steering.reader.cancel();
  const steered = await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${steerRunId}/steer`, {
    method: "POST",
    body: { input: "updated direction" },
  });
  assert.equal(steered.steered, true);
  const steerEvents = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runs/${steerRunId}/events`);
  const steerCompletion = await readEvents(steerEvents.body, (events) => events.some(isTerminalEvent));
  assert.ok(steerCompletion.events.some((event) => event.type === "runtime_steered"));
  assert.ok(steerCompletion.events.some((event) => event.type === "done"));

  const parallelA = (await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations`, {
    method: "POST",
    body: { title: "Parallel A", messages: [] },
  })).conversation;
  const parallelB = (await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations`, {
    method: "POST",
    body: { title: "Parallel B", messages: [] },
  })).conversation;
  const parallelRunA = "66666666-6666-4666-8666-666666666666";
  const parallelResponseA = await startExecution(port, workspace.id, {
    task: "BLOCK parallel A",
    sessionId: parallelA.id,
    runId: parallelRunA,
  });
  const parallelStartedA = await readEvents(
    parallelResponseA.body,
    (events) => events.some((event) => event.type === "runtime_event" && event.eventType === "turn_started"),
    { cancel: false }
  );
  await parallelStartedA.reader.cancel();
  const parallelResponseB = await startExecution(port, workspace.id, {
    task: "parallel B completes",
    sessionId: parallelB.id,
    runId: "55555555-5555-4555-8555-555555555555",
  });
  const parallelCompletionB = await readEvents(parallelResponseB.body, (events) => events.some(isTerminalEvent));
  assert.ok(parallelCompletionB.events.some((event) => event.type === "done"));
  assert.equal((await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${parallelRunA}`)).run.status, "running");
  await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${parallelRunA}/steer`, {
    method: "POST",
    body: { input: "finish parallel A" },
  });
  const parallelReplayA = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runs/${parallelRunA}/events`
  );
  const parallelCompletionA = await readEvents(parallelReplayA.body, (events) => events.some(isTerminalEvent));
  assert.ok(parallelCompletionA.events.some((event) => event.type === "done"));

  const cancelConversation = (await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations`, {
    method: "POST",
    body: { title: "Cancel approval", messages: [] },
  })).conversation;
  const cancelApprovalRunId = "88888888-8888-4888-8888-888888888888";
  const cancelApprovalResponse = await startExecution(port, workspace.id, {
    task: "APPROVAL",
    sessionId: cancelConversation.id,
    runId: cancelApprovalRunId,
  });
  const cancelWaiting = await readEvents(
    cancelApprovalResponse.body,
    (events) => events.some((event) => event.type === "runtime_request"),
    { cancel: false }
  );
  const cancelledApproval = cancelWaiting.events.find((event) => event.type === "runtime_request");
  await cancelWaiting.reader.cancel();
  const cancelled = await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${cancelApprovalRunId}/cancel`, {
    method: "POST",
  });
  assert.equal(cancelled.cancelled, true);
  const cancelledEvents = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runs/${cancelApprovalRunId}/events?after=${cancelledApproval.sequence}`
  );
  const cancelledCompletion = await readEvents(cancelledEvents.body, (events) => events.some(isTerminalEvent));
  assert.ok(cancelledCompletion.events.some((event) => event.type === "cancelled"));
  assert.equal((await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${cancelApprovalRunId}`)).run.status, "cancelled");
  const staleResolution = await jsonRequest(
    port,
    `/api/runtime-runs/${encodeURIComponent(cancelledApproval.runId)}/requests/${cancelledApproval.requestId}/resolve`,
    { method: "POST", body: { result: { decision: "accept" } } }
  );
  assert.equal(staleResolution.resolved, false);
});

test("DAG app-server approvals route to coordinator and worker turns while the root thread resumes", { timeout: 20000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-dag-app-server-test-"));
  const port = await getFreePort();
  const server = await startServer({
    home,
    logPath: path.join(home, "unused.log"),
    port,
    command: fakeAppServerPath,
    transport: "app-server",
  });
  t.after(async () => {
    await stopServer(server);
    await fs.rm(home, { recursive: true, force: true });
  });

  const agent = (await jsonRequest(port, "/api/agents", {
    method: "POST",
    body: {
      type: "dag",
      name: "DAG Control QA",
      runtimeId: "codex",
      rootNodeId: "root",
      nodes: [
        { id: "root", name: "Root", runtimeApprovalPolicy: "on-request" },
        { id: "worker", name: "Worker", runtimeApprovalPolicy: "on-request" },
      ],
      edges: [{ from: "root", to: "worker" }],
    },
  })).agent;
  const workspace = (await jsonRequest(port, "/api/workspaces", {
    method: "POST",
    body: { name: "DAG Control QA", agentIds: [agent.id] },
  })).workspace;
  const conversation = (await jsonRequest(port, `/api/workspaces/${workspace.id}/conversations`, {
    method: "POST",
    body: { title: "DAG", messages: [] },
  })).conversation;
  const runId = "77777777-7777-4777-8777-777777777777";
  const response = await startExecution(port, workspace.id, {
    task: "DAG_APPROVAL",
    agentId: agent.id,
    sessionId: conversation.id,
    runId,
  });

  const coordinatorWaiting = await readEvents(
    response.body,
    (events) => events.some((event) => event.type === "runtime_request"),
    { cancel: false }
  );
  const coordinatorApproval = coordinatorWaiting.events.find((event) => event.type === "runtime_request");
  assert.equal(coordinatorApproval.runtimeScope, "coordinator");
  assert.equal(coordinatorApproval.agentRunId, runId);
  assert.notEqual(coordinatorApproval.runtimeRunId, runId);
  await coordinatorWaiting.reader.cancel();
  assert.equal((await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${runId}`)).run.status, "waiting_approval");

  await jsonRequest(port, `/api/runtime-runs/${encodeURIComponent(coordinatorApproval.runtimeRunId)}/requests/${coordinatorApproval.requestId}/resolve`, {
    method: "POST",
    body: { result: { decision: "accept" } },
  });
  const workerResponse = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runs/${runId}/events?after=${coordinatorApproval.sequence}`
  );
  const workerWaiting = await readEvents(
    workerResponse.body,
    (events) => events.some((event) => event.type === "runtime_request" && event.runtimeScope === "node"),
    { cancel: false }
  );
  const workerApproval = workerWaiting.events.find((event) => event.type === "runtime_request" && event.runtimeScope === "node");
  assert.ok(workerApproval.nodeRunId);
  assert.notEqual(workerApproval.runtimeRunId, coordinatorApproval.runtimeRunId);
  await workerWaiting.reader.cancel();

  await jsonRequest(port, `/api/runtime-runs/${encodeURIComponent(workerApproval.runtimeRunId)}/requests/${workerApproval.requestId}/resolve`, {
    method: "POST",
    body: { result: { decision: "accept" } },
  });
  const completionResponse = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runs/${runId}/events?after=${workerApproval.sequence}`
  );
  const completion = await readEvents(completionResponse.body, (events) => events.some(isTerminalEvent));
  assert.ok(completion.events.some((event) => event.type === "dag_node_completed"));
  assert.ok(completion.events.some((event) => event.type === "done"));

  const completed = (await jsonRequest(port, `/api/workspaces/${workspace.id}/runs/${runId}`)).run;
  assert.equal(completed.status, "completed");
  assert.equal(completed.output.result, "DAG complete");
  assert.equal(completed.rootCoordinator.decisionCount, 2);
  assert.equal(completed.rootCoordinator.runtimeSession.sessionId, "thread-1");
  const workerRun = Object.values(completed.nodeRuns).find((node) => node.prototypeNodeId === "worker");
  assert.equal(workerRun.status, "completed");
  assert.equal(workerRun.runtimeSession.sessionId, "thread-2");
});

async function startServer({ home, logPath, port, command = fakeCodexPath, transport = "exec" }) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WRAPPER_PORT: String(port),
      HIPPO_APP_HOME: home,
      AGENT_STORE_PATH: path.join(home, "agent-store.json"),
      RESOURCE_ROOT_PATH: home,
      CODEX_COMMAND: command,
      CODEX_TRANSPORT: transport,
      CODEX_MODEL: "qa-model",
      FAKE_CODEX_LOG: logPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.testOutput = () => output;
  await poll(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startExecution(port, workspaceId, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspaceId}/execute/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response;
}

async function readEvents(body, until, { cancel = true } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : parts.pop() || "";
    for (const part of parts) {
      const dataLine = part.split(/\r?\n/).find((line) => line.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
    }
    if (until(events) || done) break;
  }
  if (cancel && !events.some(isTerminalEvent)) await reader.cancel();
  return { events, reader };
}

function isTerminalEvent(event) {
  return ["done", "error", "cancelled"].includes(event.type) || (event.type === "run_snapshot" && event.terminal);
}

async function jsonRequest(port, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function poll(operation, { timeoutMs = 6000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error("Timed out waiting for condition.");
}

async function readLog(logPath) {
  const content = await fs.readFile(logPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
