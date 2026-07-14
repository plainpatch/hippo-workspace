#!/usr/bin/env node
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\n");
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
const turns = new Map();
const approvedThreads = new Set();
let threadCounter = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    threadCounter += 1;
    const id = `thread-${threadCounter}`;
    send({ id: message.id, result: { thread: { id }, cwd: message.params.cwd } });
    send({ method: "thread/started", params: { thread: { id } } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId }, cwd: message.params.cwd } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${message.id}`;
    const text = message.params.input?.[0]?.text || "";
    turns.set(turnId, { threadId: message.params.threadId, requestId: message.id, text });
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId, status: "inProgress" } } });
    const output = responseFor(text);
    turns.get(turnId).output = output;
    send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "message", delta: output.slice(0, Math.max(1, Math.floor(output.length / 2))) } });
    if (text.includes("MCP_FORM")) {
      send({
        id: `mcp-${turnId}`,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: message.params.threadId,
          turnId,
          serverName: "fake-mcp",
          mode: "form",
          _meta: null,
          message: "Provide release settings",
          requestedSchema: {
            type: "object",
            properties: {
              environment: { type: "string", enum: ["staging", "production"] },
              retries: { type: "integer", minimum: 0, default: 1 },
            },
            required: ["environment"],
          },
        },
      });
    } else if (text.includes("APPROVAL") && !approvedThreads.has(message.params.threadId)) {
      send({
        id: `approval-${turnId}`,
        method: "item/commandExecution/requestApproval",
        params: { threadId: message.params.threadId, turnId, itemId: "command", command: "echo approved", cwd: message.params.cwd },
      });
    } else if (!text.includes("BLOCK")) {
      if (text.includes("STREAM_MARKDOWN")) setTimeout(() => completeTurn(turnId), 1200);
      else completeTurn(turnId);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    const turn = turns.get(message.params.turnId);
    if (turn) {
      send({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } } });
    }
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    const turn = turns.get(message.params.expectedTurnId);
    if (turn) {
      turn.text += ` ${message.params.input?.[0]?.text || ""}`;
      completeTurn(message.params.expectedTurnId);
    }
    return;
  }
  if (String(message.id).startsWith("approval-") && message.result) {
    const turnId = String(message.id).slice("approval-".length);
    if (message.result.decision === "accept") {
      const turn = turns.get(turnId);
      if (turn) approvedThreads.add(turn.threadId);
      completeTurn(turnId);
    }
  }
  if (String(message.id).startsWith("mcp-") && message.result) {
    const turnId = String(message.id).slice("mcp-".length);
    if (message.result.action === "accept") completeTurn(turnId);
  }
});

function completeTurn(turnId) {
  const turn = turns.get(turnId);
  if (!turn) return;
  const output = turn.output || "hello world";
  const split = Math.max(1, Math.floor(output.length / 2));
  send({ method: "item/agentMessage/delta", params: { threadId: turn.threadId, turnId, itemId: "message", delta: output.slice(split) } });
  send({ method: "item/completed", params: { threadId: turn.threadId, turnId, item: { type: "agentMessage", id: "message", text: output } } });
  send({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turnId, status: "completed", items: [] } } });
  turns.delete(turnId);
}

function responseFor(text) {
  if (text.includes("你是 RootAgent，也是这个 Run 的唯一调度决策者")) {
    const workerCompleted = /当前 Runtime Graph：[\s\S]*?"nodeId":\s*"worker"[\s\S]*?"status":\s*"completed"/.test(text);
    return workerCompleted
      ? JSON.stringify({ action: "complete", output: { result: "DAG complete" }, reason: "worker completed" })
      : JSON.stringify({ action: "dispatch", nodeId: "worker", input: { task: "work" }, reason: "start worker" });
  }
  if (text.includes("执行 DAG Agent 节点")) return "worker result";
  if (text.includes("STREAM_MARKDOWN")) return [
    "# 代码审查结果",
    "",
    "流式输出会先显示这一部分，并支持 `inlineCode()`。",
    "",
    "- 第一项：检查输入",
    "- 第二项：检查输出",
    "",
    "```javascript",
    "export function greet(name) {",
    "  return `hello ${name}`;",
    "}",
    "```",
    "",
    "| 文件 | 状态 |",
    "| --- | --- |",
    "| `src/app.js` | 通过 |",
    "",
    "> 代码块、表格和引用应保持清晰。",
    "",
    "[OpenAI](https://openai.com) · [童话故事.md](童话故事.md)",
    "",
    "<script>window.__unsafeMarkdown = true</script>",
  ].join("\n");
  return "hello world";
}
