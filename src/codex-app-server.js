import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_APPROVAL_POLICY = "on-request";
const USER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

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
    this.skillCache = new Map();
    this.daemonStderr = "";
    this.startPromise = null;
  }

  async execute(options = {}) {
    return this.stream(options);
  }

  async stream({ project, agent, prompt, rootSession, freshSession = false, forkSession = false, runId = randomUUID(), runtimeOptions, attachments = [], onEvent } = {}) {
    await this.ensureStarted();
    const turnSpec = await this.buildTurnSpec({ project, agent, runtimeOptions });
    const existingSessionId = freshSession ? "" : getExistingCodexSessionId(rootSession);
    const previousMcpServerUrls = getPreviousManagedMcpServerUrls(rootSession);
    const threadParams = buildThreadParams({
      project,
      adapter: this,
      turnSpec,
      previousMcpServerUrls,
    });
    const threadResult = existingSessionId && forkSession
      ? await this.request("thread/fork", {
          threadId: existingSessionId,
          ...threadParams,
        })
      : existingSessionId
        ? await this.request("thread/resume", {
          threadId: existingSessionId,
          ...threadParams,
        })
        : await this.request("thread/start", {
            ...threadParams,
            dynamicTools: turnSpec.dynamicTools.length ? turnSpec.dynamicTools : undefined,
          });
    const thread = threadResult.thread;
    if (!thread?.id) throw new CodexAppServerError("Codex app-server did not return a thread id.", 502);
    if (this.activeThreads.has(thread.id)) {
      throw new CodexAppServerError(`Codex thread ${thread.id} already has an active turn.`, 409);
    }

    const events = [];
    const record = createRunRecord({
      runId,
      threadId: thread.id,
      onEvent,
      events,
      dynamicToolHandler: turnSpec.dynamicToolHandler,
    });
    this.activeRuns.set(runId, record);
    this.activeThreads.set(thread.id, runId);
    this.emitRunEvent(record, {
      type: "runtime_event",
      runtimeId: this.id,
      runId,
      eventType: "runtime_session_started",
      sourceType: existingSessionId ? (forkSession ? "thread/forked" : "thread/resumed") : "thread/started",
      sessionId: thread.id,
      payload: threadResult,
    });

    this.armRunTimeouts(record);

    try {
      const turnResult = await this.request("turn/start", {
        threadId: thread.id,
        clientUserMessageId: runId,
        input: buildUserInput(prompt, attachments, turnSpec.skills),
        cwd: turnSpec.cwd,
        runtimeWorkspaceRoots: turnSpec.runtimeWorkspaceRoots,
        ...buildTurnOverrides(this, turnSpec),
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
          forkedFromSessionId: forkSession ? existingSessionId : "",
          workspacePath: project.localWorkspacePath || process.cwd(),
          hippoSessionId: rootSession?.id || "",
          status: "active",
          runtimeOptions: normalizeRuntimeOptions(turnSpec, this),
          updatedAt: new Date().toISOString(),
        },
      };
    } finally {
      this.cleanupRun(record);
      await this.request("thread/unsubscribe", { threadId: thread.id }, { timeoutMs: 10000 }).catch(() => {});
    }
  }

  async buildTurnSpec({ project, agent, runtimeOptions = {} }) {
    const cwd = project.localWorkspacePath || process.cwd();
    const skills = await this.resolveSkills(cwd, agent?.skills || []);
    return {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      developerInstructions: buildDeveloperInstructions(agent),
      skills,
      dynamicTools: Array.isArray(runtimeOptions.dynamicTools) ? runtimeOptions.dynamicTools : [],
      dynamicToolHandler: runtimeOptions.dynamicToolHandler,
      sandboxMode: runtimeOptions.sandboxMode || this.sandboxMode || "workspace-write",
      runtimeApprovalPolicy: normalizeApprovalPolicy(runtimeOptions.runtimeApprovalPolicy) || DEFAULT_APPROVAL_POLICY,
      mcpServerUrls: normalizeMcpServerUrls(runtimeOptions.mcpServerUrls),
    };
  }

  async resolveSkills(cwd, configuredSkills) {
    const requested = [...new Set(configuredSkills.map((skill) => String(skill?.name || skill || "").trim()).filter(Boolean))];
    if (!requested.length) return [];
    let available = this.skillCache.get(cwd) || await this.loadSkills(cwd, false);
    let missing = requested.filter((name) => !available.get(name)?.enabled);
    if (missing.length) {
      available = await this.loadSkills(cwd, true);
      missing = requested.filter((name) => !available.get(name)?.enabled);
    }
    if (missing.length) {
      throw new CodexAppServerError(`Configured Codex Skill is unavailable: ${missing.join(", ")}.`, 400, { missingSkills: missing });
    }
    return requested.map((name) => ({ type: "skill", name, path: available.get(name).path }));
  }

  async loadSkills(cwd, forceReload) {
    const response = await this.request("skills/list", { cwds: [cwd], forceReload });
    const available = new Map((response?.data || []).flatMap((entry) => entry.skills || []).map((skill) => [skill.name, skill]));
    this.skillCache.set(cwd, available);
    return available;
  }

  armRunTimeouts(record) {
    const idleTimeoutMs = positiveTimeout(process.env.CODEX_EXEC_TIMEOUT_MS, DEFAULT_EXEC_TIMEOUT_MS);
    const absoluteTimeoutMs = positiveTimeout(process.env.CODEX_ABSOLUTE_TIMEOUT_MS, DEFAULT_ABSOLUTE_TIMEOUT_MS);
    const expire = (kind, timeoutMs) => {
      void this.interruptRecord(record);
      record.reject(new CodexAppServerError(`Codex runtime ${kind} timeout after ${timeoutMs}ms.`, 504, { runId: record.runId, kind }));
    };
    record.refreshIdleTimeout = () => {
      clearTimeout(record.idleTimeout);
      record.idleTimeout = setTimeout(() => expire("inactivity", idleTimeoutMs), idleTimeoutMs);
      record.idleTimeout.unref?.();
    };
    record.refreshIdleTimeout();
    record.absoluteTimeout = setTimeout(() => expire("absolute", absoluteTimeoutMs), absoluteTimeoutMs);
    record.absoluteTimeout.unref?.();
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
    record.refreshIdleTimeout?.();
    if (params.turnId && !record.turnId) record.turnId = params.turnId;
    const event = normalizeNotification(message, record.runId);
    this.emitRunEvent(record, event);
    if (message.method === "item/agentMessage/delta" && params.delta) {
      record.finalText += params.delta;
      record.emittedDelta = true;
      this.emitRunEvent(record, { type: "stdout", text: params.delta, runId: record.runId });
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const text = params.item.text || "";
      const remainder = text.startsWith(record.finalText) ? text.slice(record.finalText.length) : "";
      if (remainder) this.emitRunEvent(record, { type: "stdout", text: remainder, runId: record.runId });
      else if (!record.emittedDelta && text) this.emitRunEvent(record, { type: "stdout", text, runId: record.runId });
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
    record.refreshIdleTimeout?.();
    if (message.method === "currentTime/read") {
      this.write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (message.method === "item/tool/call") {
      void this.handleDynamicToolRequest(message, record);
      return;
    }
    if (!USER_REQUEST_METHODS.has(message.method)) {
      this.write({ id: message.id, error: { code: -32601, message: `Hippo does not support Codex host request ${message.method}.` } });
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

  async handleDynamicToolRequest(message, record) {
    if (typeof record.dynamicToolHandler !== "function") {
      this.write({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: "No Hippo handler is registered for this tool." }] } });
      return;
    }
    try {
      const result = await record.dynamicToolHandler(message.params || {});
      this.write({ id: message.id, result: normalizeDynamicToolResult(result) });
    } catch (error) {
      this.write({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: error?.message || "Dynamic tool failed." }] } });
    }
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

  async steer(runId, input, attachments = []) {
    const record = this.activeRuns.get(runId);
    if (!record?.turnId) {
      throw new CodexAppServerError(`Runtime run ${runId} has no active turn to steer.`, 409);
    }
    const result = await this.request("turn/steer", {
      threadId: record.threadId,
      expectedTurnId: record.turnId,
      clientUserMessageId: randomUUID(),
      input: buildUserInput(input, attachments),
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

  async deleteSession(sessionId) {
    if (!sessionId) return { deleted: false, reason: "missing-session-id" };
    await this.ensureStarted();
    await this.request("thread/delete", { threadId: sessionId }, { timeoutMs: 30000 });
    return { deleted: true, sessionId };
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
    record.eventChain = record.eventChain
      .then(() => record.onEvent?.(event))
      .catch((error) => {
        record.stderr += `Hippo runtime event handler failed: ${error?.message || error}\n`;
      });
  }

  consumeStderr(chunk) {
    const text = String(chunk || "");
    this.daemonStderr = `${this.daemonStderr}${text}`.slice(-64 * 1024);
  }

  cleanupRun(record) {
    clearTimeout(record.idleTimeout);
    clearTimeout(record.absoluteTimeout);
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

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildUserInput(prompt, attachments = [], skills = []) {
  const input = [{ type: "text", text: String(prompt || ""), text_elements: [] }];
  input.push(...skills);
  for (const attachment of attachments) {
    if (!attachment?.absolutePath) continue;
    if (attachment.kind === "image") {
      input.push({ type: "localImage", path: attachment.absolutePath });
    } else {
      input.push({ type: "mention", name: attachment.name || attachment.absolutePath, path: attachment.absolutePath });
    }
  }
  return input;
}

function createRunRecord({ runId, threadId, onEvent, events, dynamicToolHandler }) {
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
    dynamicToolHandler,
    completion,
    eventChain: Promise.resolve(),
    resolve,
    reject,
    idleTimeout: undefined,
    absoluteTimeout: undefined,
    refreshIdleTimeout: undefined,
  };
}

function buildThreadParams({ project, adapter, turnSpec, previousMcpServerUrls = {} }) {
  const params = {
    model: adapter.model || undefined,
    serviceTier: adapter.serviceTier || undefined,
    cwd: turnSpec.cwd,
    runtimeWorkspaceRoots: turnSpec.runtimeWorkspaceRoots,
    developerInstructions: turnSpec.developerInstructions || null,
    approvalPolicy: turnSpec.runtimeApprovalPolicy,
    sandbox: turnSpec.sandboxMode,
    config: buildRuntimeConfig(turnSpec, previousMcpServerUrls),
  };
  return stripUndefined(params);
}

function buildTurnOverrides(adapter, turnSpec) {
  return stripUndefined({
    model: adapter.model || undefined,
    serviceTier: adapter.serviceTier || undefined,
    approvalPolicy: turnSpec.runtimeApprovalPolicy,
  });
}

function buildRuntimeConfig(turnSpec, previousMcpServerUrls = {}) {
  const entries = Object.entries(turnSpec.mcpServerUrls || {});
  const desired = new Set(entries.map(([name]) => name));
  const disabled = Object.entries(previousMcpServerUrls).filter(([name, url]) => !desired.has(name) && url);
  if (!entries.length && !disabled.length) return undefined;
  return {
    mcp_servers: Object.fromEntries([
      ...disabled.map(([name, url]) => [name, { url, enabled: false }]),
      ...entries.map(([name, url]) => [name, { url, enabled: true }]),
    ]),
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
    managedMcpServerNames: Object.keys(options?.mcpServerUrls || {}),
  };
}

function normalizeMcpServerUrls(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([name, url]) => /^[A-Za-z0-9_-]+$/.test(name) && url));
}

function getPreviousManagedMcpServerUrls(rootSession) {
  const options = rootSession?.runtimeSessions?.codex?.runtimeOptions || {};
  return normalizeMcpServerUrls(options.mcpServerUrls);
}

function buildDeveloperInstructions(agent) {
  return [
    agent?.systemPrompt,
    agent?.skills?.length ? `Only the following Hippo-configured Skills are selected for this Agent: ${agent.skills.map((skill) => skill?.name || skill).join(", ")}.` : "",
    agent?.mcpServers?.length ? `Hippo Agent MCP declarations: ${agent.mcpServers.join(", ")}. Only use servers actually exposed by the runtime.` : "",
  ].filter(Boolean).join("\n\n");
}

function normalizeDynamicToolResult(value) {
  if (value?.success !== undefined && Array.isArray(value.contentItems)) return value;
  if (typeof value === "string") return { success: true, contentItems: [{ type: "inputText", text: value }] };
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value ?? null) }] };
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
