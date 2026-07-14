import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { CodexAppServerRuntimeAdapter } from "./codex-app-server.js";

const runningProcesses = new Map();

export class CodexRuntimeAdapter {
  constructor({
    command = config.codexCommand,
    model = config.codexModel,
    sandboxMode = config.codexSandboxMode,
    serviceTier = config.codexServiceTier,
  } = {}) {
    this.id = "codex";
    this.command = command;
    this.model = model;
    this.sandboxMode = sandboxMode;
    this.serviceTier = serviceTier;
  }

  async execute({ project, agent, prompt, rootSession, freshSession = false, runId = randomUUID(), runtimeOptions } = {}) {
    const outputPath = path.join(os.tmpdir(), `hippo-codex-${Date.now()}-${process.pid}.txt`);
    const existingSessionId = freshSession ? "" : getExistingCodexSessionId(rootSession);
    const args = this.buildArgs(project, outputPath, { existingSessionId, runtimeOptions });
    args.push("-");

    const events = [];
    const { stdout, stderr } = await runCommand(this.command, args, {
      runId,
      runtimeId: this.id,
      input: prompt,
      timeoutMs: Number(process.env.CODEX_EXEC_TIMEOUT_MS || 300000),
      onStdout: (chunk) => collectJsonEvents(chunk, events),
    });

    let text = "";
    try {
      text = await fs.readFile(outputPath, "utf8");
    } catch {
      text = stdout;
    } finally {
      await fs.unlink(outputPath).catch(() => {});
    }

    return {
      runtimeId: this.id,
      runId,
      agentId: agent?.id,
      text: text.trim() || stdout.trim(),
      stdout,
      stderr,
      events,
      runtimeSession: buildRuntimeSession({
        project,
        rootSession,
        sessionId: extractCodexSessionId(events, stdout) || getExistingCodexSessionId(rootSession),
        resumedFromSessionId: existingSessionId,
        status: events.length ? "active" : "ephemeral",
        runtimeOptions: normalizeRuntimeOptions(runtimeOptions, this),
      }),
    };
  }

  async stream({ project, agent, prompt, rootSession, freshSession = false, runId = randomUUID(), runtimeOptions, onEvent } = {}) {
    const outputPath = path.join(os.tmpdir(), `hippo-codex-${Date.now()}-${process.pid}.txt`);
    const existingSessionId = freshSession ? "" : getExistingCodexSessionId(rootSession);
    const args = this.buildArgs(project, outputPath, { existingSessionId, runtimeOptions });
    args.push("-");

    const events = [];
    const collectStreamEvents = createJsonLineCollector();
    let eventChain = Promise.resolve();
    const emit = (event) => {
      eventChain = eventChain.then(() => onEvent?.(event));
      eventChain.catch(() => {});
    };
    const { stdout, stderr } = await runCommand(this.command, args, {
      runId,
      runtimeId: this.id,
      input: prompt,
      timeoutMs: Number(process.env.CODEX_EXEC_TIMEOUT_MS || 300000),
      onStdout: (chunk) => {
        const parsed = collectStreamEvents(chunk);
        if (parsed.passthrough) emit({ type: "stdout", text: parsed.passthrough });
        for (const event of parsed.events) {
          events.push(event);
          const normalized = normalizeCodexEvent(event, { runId, runtimeId: this.id });
          emit(normalized);
          if (normalized.text) emit({ type: "stdout", text: normalized.text });
        }
      },
      onStderr: (chunk) => emit({ type: "stderr", text: chunk }),
    });
    await eventChain;

    let text = "";
    try {
      text = await fs.readFile(outputPath, "utf8");
    } catch {
      text = stdout;
    } finally {
      await fs.unlink(outputPath).catch(() => {});
    }

    return {
      runtimeId: this.id,
      runId,
      agentId: agent?.id,
      text: text.trim() || stdout.trim(),
      stdout,
      stderr,
      events,
      runtimeSession: buildRuntimeSession({
        project,
        rootSession,
        sessionId: extractCodexSessionId(events, stdout) || getExistingCodexSessionId(rootSession),
        resumedFromSessionId: existingSessionId,
        status: events.length ? "active" : "ephemeral",
        runtimeOptions: normalizeRuntimeOptions(runtimeOptions, this),
      }),
    };
  }

  buildArgs(project, outputPath, { existingSessionId = "", runtimeOptions } = {}) {
    const serviceTierConfig = this.serviceTier ? `service_tier="${this.serviceTier}"` : "";
    const sandboxMode = runtimeOptions?.sandboxMode || this.sandboxMode;
    const runtimeApprovalPolicy = normalizeRuntimeApprovalPolicy(runtimeOptions?.runtimeApprovalPolicy);
    const commandArgs = existingSessionId ? [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
    ] : [
      "exec",
      "--json",
      "--cd",
      project.localWorkspacePath || process.cwd(),
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
    ];
    if (serviceTierConfig) commandArgs.splice(4, 0, "-c", serviceTierConfig);
    if (runtimeOptions?.ignoreUserConfig) commandArgs.splice(existingSessionId ? 2 : 1, 0, "--ignore-user-config");
    if (this.model) commandArgs.push("--model", this.model);
    if (existingSessionId) commandArgs.push(existingSessionId);

    const globalArgs = [];
    if (sandboxMode) globalArgs.push("--sandbox", sandboxMode);
    if (runtimeApprovalPolicy !== "inherit") {
      globalArgs.push("--ask-for-approval", runtimeApprovalPolicy);
    }
    for (const [name, url] of Object.entries(runtimeOptions?.mcpServerUrls || {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || !url) continue;
      globalArgs.push("-c", `mcp_servers.${name}.url=${JSON.stringify(String(url))}`);
    }
    return [...globalArgs, ...commandArgs];
  }

  cancel(runId) {
    return cancelRuntimeProcess(runId);
  }
}

function collectJsonEvents(chunk, target) {
  const parsed = [];
  for (const line of String(chunk || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed);
      target.push(event);
      parsed.push(event);
    } catch {
      // Codex may interleave non-JSON progress text; keep stdout intact as fallback.
    }
  }
  return parsed;
}

function createJsonLineCollector() {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk || "");
    const events = [];
    const passthrough = [];
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("{")) {
        passthrough.push(line);
        continue;
      }
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        passthrough.push(line);
      }
    }
    if (buffer && !buffer.trimStart().startsWith("{")) {
      passthrough.push(buffer);
      buffer = "";
    }
    return { events, passthrough: passthrough.join("\n") };
  };
}

function getExistingCodexSessionId(rootSession) {
  return rootSession?.runtimeSessions?.codex?.sessionId || "";
}

function extractCodexSessionId(events, stdout) {
  for (const event of events || []) {
    const candidates = [
      event.session_id,
      event.sessionId,
      event.thread_id,
      event.threadId,
      event.conversation_id,
      event.conversationId,
      event.id && String(event.type || "").includes("session") ? event.id : "",
      event.payload?.session_id,
      event.payload?.sessionId,
      event.payload?.thread_id,
      event.payload?.threadId,
      event.data?.session_id,
      event.data?.sessionId,
      event.data?.thread_id,
      event.data?.threadId,
    ].filter(Boolean);
    if (candidates.length) return String(candidates[0]);
  }
  const match = String(stdout || "").match(/"session[_-]?id"\s*:\s*"([^"]+)"/i);
  return match?.[1] || "";
}

function buildRuntimeSession({ project, rootSession, sessionId, resumedFromSessionId, status, runtimeOptions }) {
  return {
    provider: "codex",
    sessionId: sessionId || "",
    resumedFromSessionId: resumedFromSessionId || "",
    workspacePath: project.localWorkspacePath || process.cwd(),
    hippoSessionId: rootSession?.id || "",
    status: sessionId ? status : "ephemeral",
    runtimeOptions: runtimeOptions || {},
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRuntimeOptions(options, adapter) {
  return {
    sandboxMode: options?.sandboxMode || adapter.sandboxMode || "",
    runtimeApprovalPolicy: normalizeRuntimeApprovalPolicy(options?.runtimeApprovalPolicy),
    mcpServerUrls: options?.mcpServerUrls || {},
    ignoreUserConfig: options?.ignoreUserConfig === true,
  };
}

function normalizeRuntimeApprovalPolicy(value) {
  return ["untrusted", "on-request", "never"].includes(value) ? value : "inherit";
}

function normalizeCodexEvent(event, { runId, runtimeId }) {
  const type = event?.type || "unknown";
  const text = extractEventText(event);
  const mappedType = {
    "thread.started": "runtime_session_started",
    "turn.started": "runtime_turn_started",
    "turn.completed": "runtime_turn_completed",
    "item.started": "runtime_item_started",
    "item.completed": "runtime_item_completed",
    "item.updated": "runtime_item_updated",
  }[type] || "runtime_event";
  return {
    type: "runtime_event",
    runtimeId,
    runId,
    eventType: mappedType,
    sourceType: type,
    sessionId: mappedType === "runtime_session_started" ? extractCodexSessionId([event], "") : "",
    text,
    payload: event,
  };
}

function extractEventText(value) {
  if (!value || typeof value !== "object") return "";
  const direct = [
    value.delta,
    value.text,
    value.message,
    value.output_text,
    value.item?.text,
    value.item?.delta,
    value.item?.message,
    value.item?.output_text,
  ].find((item) => typeof item === "string" && item);
  if (direct) return direct;
  const content = value.content || value.item?.content || value.data?.content || value.payload?.content;
  return extractContentText(content);
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.text || item.delta || item.output_text || "";
    })
    .filter(Boolean)
    .join("");
}

function cancelRuntimeProcess(runId) {
  const record = runningProcesses.get(runId);
  if (!record) {
    return { cancelled: false, reason: "run-not-active", runId };
  }
  record.cancelled = true;
  record.child.kill("SIGTERM");
  setTimeout(() => {
    if (!record.exited) record.child.kill("SIGKILL");
  }, 2000).unref();
  return { cancelled: true, runId, pid: record.child.pid };
}

export function cancelRuntimeRun(runId) {
  return cancelRuntimeProcess(runId);
}

function runCommand(command, args, { runId, runtimeId, input, timeoutMs, onStdout, onStderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (runId) runningProcesses.set(runId, { child, command, args, runtimeId, startedAt: new Date().toISOString(), cancelled: false, exited: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        const record = runId ? runningProcesses.get(runId) : undefined;
        if (!record?.exited) child.kill("SIGKILL");
      }, 2000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderr?.(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (runId) runningProcesses.delete(runId);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const record = runId ? runningProcesses.get(runId) : undefined;
      if (record) record.exited = true;
      if (runId) runningProcesses.delete(runId);
      if (record?.cancelled) {
        reject(new RuntimeAdapterError(`Runtime run ${runId} was cancelled.`, 499, {
          command,
          args,
          stdout,
          stderr,
          signal,
          runId,
          cancelled: true,
        }));
        return;
      }
      if (timedOut) {
        reject(new RuntimeAdapterError(`Codex runtime timed out after ${timeoutMs}ms.`, 504, {
          command,
          args,
          stdout,
          stderr,
          signal,
          runId,
        }));
        return;
      }
      if (code !== 0) {
        reject(new RuntimeAdapterError(`Codex runtime exited with code ${code}.`, 502, {
          command,
          args,
          stdout,
          stderr,
          signal,
          runId,
        }));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.end(input);
  });
}

export class RuntimeRegistry {
  constructor({ settings }) {
    this.settings = {
      defaultRuntimeId: config.defaultRuntimeId,
      runtimes: {
        codex: {
          command: config.codexCommand,
          transport: config.codexTransport,
          model: config.codexModel || undefined,
          sandboxMode: config.codexSandboxMode,
          serviceTier: config.codexServiceTier,
        },
      },
      ...(settings || {}),
    };
  }

  getRuntime(id = this.settings.defaultRuntimeId) {
    if (id === "codex") {
      const runtimeSettings = this.settings.runtimes.codex || {};
      const Adapter = runtimeSettings.transport === "exec" ? CodexRuntimeAdapter : CodexAppServerRuntimeAdapter;
      if (!this.codexRuntime || !(this.codexRuntime instanceof Adapter)) {
        this.codexRuntime = new Adapter(runtimeSettings);
      }
      return this.codexRuntime;
    }
    throw new RuntimeAdapterError(`Unsupported runtime: ${id}`, 400);
  }

  updateSettings(settings = {}) {
    const nextSettings = {
      ...this.settings,
      ...settings,
      runtimes: {
        ...(this.settings.runtimes || {}),
        ...(settings.runtimes || {}),
      },
    };
    const runtimeChanged = JSON.stringify(this.settings.runtimes?.codex || {}) !==
      JSON.stringify(nextSettings.runtimes?.codex || {});
    if (runtimeChanged) {
      this.codexRuntime?.close?.();
      this.codexRuntime = null;
    }
    this.settings = nextSettings;
    return this.settings;
  }

  cancelRun(runId) {
    return this.codexRuntime?.cancel(runId) || cancelRuntimeRun(runId);
  }

  resolveRequest(runId, requestId, result) {
    return this.codexRuntime?.resolveRequest?.(runId, requestId, result) || {
      resolved: false,
      reason: "runtime-request-not-active",
      runId,
      requestId,
    };
  }

  steerRun(runId, input) {
    if (!this.codexRuntime?.steer) {
      throw new RuntimeAdapterError("The active runtime transport does not support turn steering.", 409);
    }
    return this.codexRuntime.steer(runId, input);
  }
}

export class RuntimeAdapterError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.name = "RuntimeAdapterError";
    this.status = status;
    this.details = details;
  }
}
