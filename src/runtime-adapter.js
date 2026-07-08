import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

export class CodexRuntimeAdapter {
  constructor({ command = config.codexCommand, model = config.codexModel } = {}) {
    this.id = "codex";
    this.command = command;
    this.model = model;
  }

  async execute({ project, agent, prompt }) {
    const outputPath = path.join(os.tmpdir(), `hippo-codex-${Date.now()}-${process.pid}.txt`);
    const args = this.buildArgs(project, outputPath);
    if (this.model) args.push("--model", this.model);
    args.push("-");

    const { stdout, stderr } = await runCommand(this.command, args, {
      input: prompt,
      timeoutMs: Number(process.env.CODEX_EXEC_TIMEOUT_MS || 300000),
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
      agentId: agent?.id,
      text: text.trim() || stdout.trim(),
      stdout,
      stderr,
    };
  }

  async stream({ project, agent, prompt, onEvent }) {
    const outputPath = path.join(os.tmpdir(), `hippo-codex-${Date.now()}-${process.pid}.txt`);
    const args = this.buildArgs(project, outputPath);
    if (this.model) args.push("--model", this.model);
    args.push("-");

    const { stdout, stderr } = await runCommand(this.command, args, {
      input: prompt,
      timeoutMs: Number(process.env.CODEX_EXEC_TIMEOUT_MS || 300000),
      onStdout: (chunk) => onEvent?.({ type: "stdout", text: chunk }),
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
      agentId: agent?.id,
      text: text.trim() || stdout.trim(),
      stdout,
      stderr,
    };
  }

  buildArgs(project, outputPath) {
    return [
      "exec",
      "--cd",
      project.localWorkspacePath || process.cwd(),
      "--skip-git-repo-check",
      "-c",
      'service_tier="fast"',
      "--sandbox",
      "workspace-write",
      "--output-last-message",
      outputPath,
    ];
  }
}

function runCommand(command, args, { input, timeoutMs, onStdout, onStderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
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
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new RuntimeAdapterError(`Codex runtime timed out after ${timeoutMs}ms.`, 504, {
          command,
          args,
          stdout,
          stderr,
          signal,
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
}

export class RuntimeAdapterError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.name = "RuntimeAdapterError";
    this.status = status;
    this.details = details;
  }
}
