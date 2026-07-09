import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

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

  async execute({ project, agent, prompt, rootSession, reset = false, runId = randomUUID(), contextPolicy, runtimeOptions } = {}) {
    const outputPath = path.join(os.tmpdir(), `hippo-codex-${Date.now()}-${process.pid}.txt`);
    const existingSessionId = reset ? "" : getExistingCodexSessionId(rootSession);
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
        contextPolicy,
        runtimeOptions: normalizeRuntimeOptions(runtimeOptions, this),
      }),
    };
  }

  async stream({ project, agent, prompt, rootSession, reset = false, runId = randomUUID(), contextPolicy, runtimeOptions, onEvent } = {}) {
    const outputPath = path.join(os.tmpdir(), `hippo-codex-${Date.now()}-${process.pid}.txt`);
    const existingSessionId = reset ? "" : getExistingCodexSessionId(rootSession);
    const args = this.buildArgs(project, outputPath, { existingSessionId, runtimeOptions });
    args.push("-");

    const events = [];
    const collectStreamEvents = createJsonLineCollector();
    const { stdout, stderr } = await runCommand(this.command, args, {
      runId,
      runtimeId: this.id,
      input: prompt,
      timeoutMs: Number(process.env.CODEX_EXEC_TIMEOUT_MS || 300000),
      onStdout: (chunk) => {
        const parsed = collectStreamEvents(chunk);
        if (parsed.passthrough) onEvent?.({ type: "stdout", text: parsed.passthrough });
        for (const event of parsed.events) {
          events.push(event);
          const normalized = normalizeCodexEvent(event, { runId, runtimeId: this.id });
          onEvent?.(normalized);
          if (normalized.text) onEvent?.({ type: "stdout", text: normalized.text });
        }
      },
      onStderr: (chunk) => onEvent?.({ type: "stderr", text: chunk }),
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
        contextPolicy,
        runtimeOptions: normalizeRuntimeOptions(runtimeOptions, this),
      }),
    };
  }

  buildArgs(project, outputPath, { existingSessionId = "", runtimeOptions } = {}) {
    const serviceTierConfig = this.serviceTier ? `service_tier="${this.serviceTier}"` : "";
    const sandboxMode = runtimeOptions?.sandboxMode || this.sandboxMode;
    const args = existingSessionId ? [
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
    if (serviceTierConfig) args.splice(existingSessionId ? 4 : 4, 0, "-c", serviceTierConfig);
    if (!existingSessionId && sandboxMode) args.splice(args.length - 2, 0, "--sandbox", sandboxMode);
    if (this.model) args.push("--model", this.model);
    if (existingSessionId) args.push(existingSessionId);
    return args;
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

function buildRuntimeSession({ project, rootSession, sessionId, resumedFromSessionId, status, contextPolicy, runtimeOptions }) {
  return {
    provider: "codex",
    sessionId: sessionId || "",
    resumedFromSessionId: resumedFromSessionId || "",
    workspacePath: project.localWorkspacePath || process.cwd(),
    hippoSessionId: rootSession?.id || "",
    status: sessionId ? status : "ephemeral",
    contextPolicy: normalizeContextPolicy(contextPolicy),
    runtimeOptions: runtimeOptions || {},
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRuntimeOptions(options, adapter) {
  return {
    sandboxMode: options?.sandboxMode || adapter.sandboxMode || "",
  };
}

function normalizeContextPolicy(policy) {
  const strategy = ["runtime", "reset", "manual-summary"].includes(policy?.strategy)
    ? policy.strategy
    : "runtime";
  return {
    strategy,
    summary: policy?.summary || "",
    summaryUpdatedAt: policy?.summaryUpdatedAt || "",
  };
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
      return new CodexRuntimeAdapter(this.settings.runtimes.codex);
    }
    throw new RuntimeAdapterError(`Unsupported runtime: ${id}`, 400);
  }

  updateSettings(settings = {}) {
    this.settings = {
      ...this.settings,
      ...settings,
      runtimes: {
        ...(this.settings.runtimes || {}),
        ...(settings.runtimes || {}),
      },
    };
    return this.settings;
  }

  cancelRun(runId) {
    return cancelRuntimeRun(runId);
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
