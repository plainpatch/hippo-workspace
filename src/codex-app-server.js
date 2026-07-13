import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export class CodexAppServerRuntimeAdapter {
  constructor({ command = "codex", model = "", sandboxMode = "workspace-write", serviceTier = "fast" } = {}) {
    this.id = "codex";
    this.command = command;
    this.model = model;
    this.sandboxMode = sandboxMode;
    this.serviceTier = serviceTier;
    this.child = null;
    this.buffer = "";
    this.nextRequestId = 1;
    this.pendingRpc = new Map();
    this.activeRuns = new Map();
    this.activeThreads = new Map();
    this.runtimeRequests = new Map();
    this.startPromise = null;
  }

  async execute(options = {}) {
    return this.stream(options);
  }

  async stream({ project, agent, prompt, rootSession, freshSession = false, runId = randomUUID(), runtimeOptions, onEvent } = {}) {
    await this.ensureStarted();
    const existingSessionId = freshSession ? "" : getExistingCodexSessionId(rootSession);
    const threadResult = existingSessionId
      ? await this.request("thread/resume", buildThreadParams({
          threadId: existingSessionId,
          project,
          adapter: this,
          runtimeOptions,
        }))
      : await this.request("thread/start", buildThreadParams({ project, adapter: this, runtimeOptions }));
    const thread = threadResult.thread;
    if (!thread?.id) throw new CodexAppServerError("Codex app-server did not return a thread id.", 502);
    if (this.activeThreads.has(thread.id)) {
      throw new CodexAppServerError(`Codex thread ${thread.id} already has an active turn.`, 409);
    }

    const events = [];
    const record = createRunRecord({ runId, threadId: thread.id, onEvent, events });
    this.activeRuns.set(runId, record);
    this.activeThreads.set(thread.id, runId);
    this.emitRunEvent(record, {
      type: "runtime_event",
      runtimeId: this.id,
      runId,
      eventType: "runtime_session_started",
      sourceType: existingSessionId ? "thread/resumed" : "thread/started",
      sessionId: thread.id,
      payload: threadResult,
    });

    const timeoutMs = Number(process.env.CODEX_EXEC_TIMEOUT_MS || 300000);
    record.timeout = setTimeout(() => {
      void this.interruptRecord(record);
      record.reject(new CodexAppServerError(`Codex runtime timed out after ${timeoutMs}ms.`, 504, { runId }));
    }, timeoutMs);
    record.timeout.unref?.();

    try {
      const turnResult = await this.request("turn/start", {
        threadId: thread.id,
        clientUserMessageId: runId,
        input: [{ type: "text", text: prompt || "", text_elements: [] }],
        cwd: project.localWorkspacePath || process.cwd(),
        runtimeWorkspaceRoots: [project.localWorkspacePath || process.cwd()],
        ...buildTurnOverrides(this, runtimeOptions),
      });
      record.turnId = turnResult.turn?.id || record.turnId;
      const completion = await record.completion;
      await record.eventChain;
      if (completion.status === "interrupted") {
        throw new CodexAppServerError(`Runtime run ${runId} was cancelled.`, 499, { cancelled: true, runId });
      }
      if (completion.status === "failed") {
        throw new CodexAppServerError(completion.error?.message || "Codex turn failed.", 502, completion.error);
      }
      return {
        runtimeId: this.id,
        runId,
        agentId: agent?.id,
        text: record.finalText.trim(),
        stdout: record.finalText,
        stderr: record.stderr,
        events,
        runtimeSession: {
          provider: "codex",
          sessionId: thread.id,
          resumedFromSessionId: existingSessionId,
          workspacePath: project.localWorkspacePath || process.cwd(),
          hippoSessionId: rootSession?.id || "",
          status: "active",
          runtimeOptions: normalizeRuntimeOptions(runtimeOptions, this),
          updatedAt: new Date().toISOString(),
        },
      };
    } finally {
      this.cleanupRun(record);
    }
  }

  async ensureStarted() {
    if (this.child && this.child.exitCode === null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start() {
    const child = spawn(this.command, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => this.consumeStderr(chunk));
    child.on("error", (error) => this.handleExit(error));
    child.on("close", (code, signal) => this.handleExit(new CodexAppServerError(
      `Codex app-server exited${code === null ? "" : ` with code ${code}`}.`,
      502,
      { code, signal }
    )));
    await this.request("initialize", {
      clientInfo: { name: "hippo", title: "Hippo", version: "1.0.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    }, { allowUnstarted: true, timeoutMs: 30000 });
    this.notify("initialized");
  }

  request(method, params, { allowUnstarted = false, timeoutMs = 60000 } = {}) {
    if (!allowUnstarted && (!this.child || this.child.exitCode !== null)) {
      return Promise.reject(new CodexAppServerError("Codex app-server is not running.", 503));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(String(id));
        reject(new CodexAppServerError(`Codex app-server request ${method} timed out.`, 504));
      }, timeoutMs);
      timeout.unref?.();
      this.pendingRpc.set(String(id), { method, resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }

  notify(method, params = undefined) {
    this.write(params === undefined ? { method } : { method, params });
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new CodexAppServerError("Codex app-server stdin is unavailable.", 503);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  consume(chunk) {
    this.buffer += String(chunk || "");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.consumeStderr(`Invalid app-server message: ${error.message}\n`);
      }
    }
  }

  handleMessage(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pendingRpc.get(String(message.id));
      if (!pending) return;
      this.pendingRpc.delete(String(message.id));
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new CodexAppServerError(message.error.message || `Codex request ${pending.method} failed.`, 502, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message);
  }

  handleNotification(message) {
    const params = message.params || {};
    const runId = this.activeThreads.get(params.threadId);
    const record = runId ? this.activeRuns.get(runId) : undefined;
    if (!record) return;
    if (params.turnId && !record.turnId) record.turnId = params.turnId;
    const event = normalizeNotification(message, record.runId);
    this.emitRunEvent(record, event);
    if (message.method === "item/agentMessage/delta" && params.delta) {
      record.finalText += params.delta;
      record.emittedDelta = true;
      this.emitRunEvent(record, { type: "stdout", text: params.delta, runId: record.runId });
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const text = params.item.text || "";
      if (!record.emittedDelta && text) this.emitRunEvent(record, { type: "stdout", text, runId: record.runId });
      record.finalText = text || record.finalText;
    } else if (message.method === "turn/completed") {
      const turn = params.turn || {};
      record.resolve({ status: turn.status || "completed", error: turn.error, turn });
    } else if (message.method === "error" && !params.willRetry) {
      record.reject(new CodexAppServerError(params.error?.message || "Codex turn failed.", 502, params.error));
    }
  }

  handleServerRequest(message) {
    const params = message.params || {};
    const runId = this.activeThreads.get(params.threadId);
    const record = runId ? this.activeRuns.get(runId) : undefined;
    if (!record) {
      this.write({ id: message.id, error: { code: -32001, message: "No active Hippo run owns this request." } });
      return;
    }
    const requestId = String(message.id);
    const key = `${record.runId}:${requestId}`;
    this.runtimeRequests.set(key, { id: message.id, method: message.method, record });
    this.emitRunEvent(record, {
      type: "runtime_request",
      runtimeId: this.id,
      runId: record.runId,
      requestId,
      requestType: message.method,
      params,
    });
  }

  resolveRequest(runId, requestId, result) {
    const key = `${runId}:${requestId}`;
    const pending = this.runtimeRequests.get(key);
    if (!pending) return { resolved: false, reason: "request-not-active", runId, requestId };
    this.runtimeRequests.delete(key);
    this.write({ id: pending.id, result });
    this.emitRunEvent(pending.record, {
      type: "runtime_request_resolved",
      runtimeId: this.id,
      runId,
      requestId,
      requestType: pending.method,
      result,
    });
    return { resolved: true, runId, requestId };
  }

  cancel(runId) {
    const record = this.activeRuns.get(runId);
    if (!record) return { cancelled: false, reason: "run-not-active", runId };
    void this.interruptRecord(record);
    return { cancelled: true, runId, threadId: record.threadId, turnId: record.turnId };
  }

  async steer(runId, input) {
    const record = this.activeRuns.get(runId);
    if (!record?.turnId) {
      throw new CodexAppServerError(`Runtime run ${runId} has no active turn to steer.`, 409);
    }
    const result = await this.request("turn/steer", {
      threadId: record.threadId,
      expectedTurnId: record.turnId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text: String(input || ""), text_elements: [] }],
    });
    this.emitRunEvent(record, {
      type: "runtime_steered",
      runtimeId: this.id,
      runId,
      threadId: record.threadId,
      turnId: record.turnId,
      input: String(input || ""),
    });
    return { steered: true, runId, threadId: record.threadId, turnId: result.turnId || record.turnId };
  }

  close() {
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  async interruptRecord(record) {
    if (!record.turnId) return;
    await this.request("turn/interrupt", { threadId: record.threadId, turnId: record.turnId }).catch(() => {});
  }

  emitRunEvent(record, event) {
    record.events.push(event);
    record.eventChain = record.eventChain.then(() => record.onEvent?.(event));
    record.eventChain.catch(() => {});
  }

  consumeStderr(chunk) {
    const text = String(chunk || "");
    for (const record of this.activeRuns.values()) record.stderr += text;
  }

  cleanupRun(record) {
    clearTimeout(record.timeout);
    this.activeRuns.delete(record.runId);
    if (this.activeThreads.get(record.threadId) === record.runId) this.activeThreads.delete(record.threadId);
    for (const [key, request] of this.runtimeRequests) {
      if (request.record === record) this.runtimeRequests.delete(key);
    }
  }

  handleExit(error) {
    if (this.child) this.child = null;
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRpc.clear();
    for (const record of this.activeRuns.values()) record.reject(error);
  }
}

function createRunRecord({ runId, threadId, onEvent, events }) {
  let resolve;
  let reject;
  const completion = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  completion.catch(() => {});
  return {
    runId,
    threadId,
    turnId: "",
    onEvent,
    events,
    finalText: "",
    stderr: "",
    emittedDelta: false,
    completion,
    eventChain: Promise.resolve(),
    resolve,
    reject,
    timeout: undefined,
  };
}

function buildThreadParams({ threadId, project, adapter, runtimeOptions }) {
  const params = {
    ...(threadId ? { threadId } : {}),
    model: adapter.model || undefined,
    serviceTier: adapter.serviceTier || undefined,
    cwd: project.localWorkspacePath || process.cwd(),
    runtimeWorkspaceRoots: [project.localWorkspacePath || process.cwd()],
    approvalPolicy: normalizeApprovalPolicy(runtimeOptions?.runtimeApprovalPolicy),
    sandbox: runtimeOptions?.sandboxMode || adapter.sandboxMode || undefined,
    config: buildRuntimeConfig(runtimeOptions),
  };
  return stripUndefined(params);
}

function buildTurnOverrides(adapter, runtimeOptions) {
  return stripUndefined({
    model: adapter.model || undefined,
    serviceTier: adapter.serviceTier || undefined,
    approvalPolicy: normalizeApprovalPolicy(runtimeOptions?.runtimeApprovalPolicy),
  });
}

function buildRuntimeConfig(runtimeOptions) {
  const entries = Object.entries(runtimeOptions?.mcpServerUrls || {});
  if (!entries.length) return undefined;
  return {
    mcp_servers: Object.fromEntries(entries.map(([name, url]) => [name, { url }])),
  };
}

function normalizeApprovalPolicy(value) {
  return ["untrusted", "on-request", "never"].includes(value) ? value : undefined;
}

function normalizeRuntimeOptions(options, adapter) {
  return {
    sandboxMode: options?.sandboxMode || adapter.sandboxMode || "",
    runtimeApprovalPolicy: normalizeApprovalPolicy(options?.runtimeApprovalPolicy) || "inherit",
    mcpServerUrls: options?.mcpServerUrls || {},
  };
}

function normalizeNotification(message, runId) {
  return {
    type: "runtime_event",
    runtimeId: "codex",
    runId,
    eventType: String(message.method || "runtime_event").replaceAll("/", "_"),
    sourceType: message.method || "runtime_event",
    payload: message.params,
  };
}

function getExistingCodexSessionId(rootSession) {
  return rootSession?.runtimeSessions?.codex?.sessionId || "";
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export class CodexAppServerError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.name = "CodexAppServerError";
    this.status = status;
    this.details = details;
  }
}
