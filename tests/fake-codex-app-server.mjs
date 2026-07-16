#!/usr/bin/env node
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\n");
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
const turns = new Map();
const threadOptions = new Map();
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
  if (message.method === "skills/list") {
    const cwd = message.params.cwds?.[0] || process.cwd();
    const skills = [
      { name: "imagegen", path: "/tmp/skills/imagegen/SKILL.md", description: "Image generation skill", enabled: true, scope: "system" },
      { name: "qa-skill", path: "/tmp/skills/qa-skill/SKILL.md", description: "QA skill", enabled: true, scope: "repo" },
    ];
    if (message.params.forceReload) skills.push({ name: "new-skill", path: "/tmp/skills/new-skill/SKILL.md", description: "Newly installed skill", enabled: true, scope: "repo" });
    send({ id: message.id, result: { data: [{ cwd, errors: [], skills }] } });
    return;
  }
  if (message.method === "thread/start") {
    threadCounter += 1;
    const id = `thread-${threadCounter}`;
    threadOptions.set(id, applyThreadOptions({}, message.params));
    send({ id: message.id, result: { thread: { id }, cwd: message.params.cwd } });
    send({ method: "thread/started", params: { thread: { id } } });
    return;
  }
  if (message.method === "thread/resume") {
    if (hasInvalidDisabledMcp(message.params)) {
      send({ id: message.id, error: { code: -32600, message: "failed to load configuration: invalid transport" } });
      return;
    }
    threadOptions.set(message.params.threadId, applyThreadOptions(threadOptions.get(message.params.threadId), message.params));
    send({ id: message.id, result: { thread: { id: message.params.threadId }, cwd: message.params.cwd } });
    return;
  }
  if (message.method === "thread/fork") {
    threadCounter += 1;
    const id = `thread-${threadCounter}`;
    threadOptions.set(id, applyThreadOptions(threadOptions.get(message.params.threadId), message.params));
    send({ id: message.id, result: { thread: { id }, cwd: message.params.cwd } });
    send({ method: "thread/started", params: { thread: { id } } });
    return;
  }
  if (message.method === "thread/unsubscribe") {
    send({ id: message.id, result: { status: "unsubscribed" } });
    return;
  }
  if (message.method === "thread/delete") {
    threadOptions.delete(message.params.threadId);
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${message.id}`;
    const input = message.params.input || [];
    const text = input.find((item) => item.type === "text")?.text || "";
    turns.set(turnId, { threadId: message.params.threadId, requestId: message.id, text });
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId, status: "inProgress" } } });
    const graphUrl = threadOptions.get(message.params.threadId)?.graphUrl || "";
    const isRootCoordinator = text.includes("你是 RootAgent，也是这个 Run 的唯一调度决策者");
    const output = isRootCoordinator && graphUrl ? "Graph scheduling tools were invoked." : responseFor(text, input, message.params, threadOptions.get(message.params.threadId));
    turns.get(turnId).output = output;
    turns.get(turnId).graphUrl = isRootCoordinator ? graphUrl : "";
    if (!isRootCoordinator || !graphUrl) {
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "message", delta: output.slice(0, Math.max(1, Math.floor(output.length / 2))) } });
    }
    if (text.includes("DYNAMIC_TOOL")) {
      send({
        id: `tool-${turnId}`,
        method: "item/tool/call",
        params: { threadId: message.params.threadId, turnId, callId: `call-${turnId}`, namespace: "hippo", tool: "echo", arguments: { value: "ping" } },
      });
    } else if (text.includes("CURRENT_TIME")) {
      send({ id: `time-${turnId}`, method: "currentTime/read", params: { threadId: message.params.threadId, turnId } });
    } else if (text.includes("MCP_FORM")) {
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
    } else if (isRootCoordinator && graphUrl) {
      void runGraphTurn(turnId).catch((error) => failTurn(turnId, error));
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
      if (turn?.graphUrl) void runGraphTurn(turnId).catch((error) => failTurn(turnId, error));
      else completeTurn(turnId);
    }
  }
  if (String(message.id).startsWith("mcp-") && message.result) {
    const turnId = String(message.id).slice("mcp-".length);
    if (message.result.action === "accept") completeTurn(turnId);
  }
  if (String(message.id).startsWith("tool-") && message.result) {
    const turnId = String(message.id).slice("tool-".length);
    const turn = turns.get(turnId);
    if (turn) turn.output = JSON.stringify(message.result);
    completeTurn(turnId);
  }
  if (String(message.id).startsWith("time-") && message.result) {
    const turnId = String(message.id).slice("time-".length);
    const turn = turns.get(turnId);
    if (turn) turn.output = JSON.stringify(message.result);
    completeTurn(turnId);
  }
});

function applyThreadOptions(previous = {}, params = {}) {
  const mcpServers = { ...(previous?.mcpServers || {}) };
  for (const [name, value] of Object.entries(params.config?.mcp_servers || {})) {
    if (value?.enabled === false) delete mcpServers[name];
    else if (value?.url) mcpServers[name] = value.url;
  }
  return {
    ...previous,
    mcpServers,
    graphUrl: mcpServers.hippo_graph || "",
    developerInstructions: params.developerInstructions,
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
  };
}

function hasInvalidDisabledMcp(params = {}) {
  return Object.values(params.config?.mcp_servers || {}).some((server) => server?.enabled === false && !server?.url);
}

async function runGraphTurn(turnId) {
  const turn = turns.get(turnId);
  if (!turn) return;
  const contextQa = turn.text.includes("Blueprint_CONTEXT_QA");
  const workerCompleted = /当前 Runtime Graph：[\s\S]*?"nodeId":\s*"worker"[\s\S]*?"status":\s*"completed"/.test(turn.text);
  if (!workerCompleted) {
    const contextRef = [...turn.text.matchAll(/ctx:\/\/[A-Za-z0-9._-]+\/message-[a-f0-9]+@\d+/g)].at(-1)?.[0];
    const dispatched = await callMcpTool(turn.graphUrl, "hippo_dispatch_graph_node", {
      nodeId: "worker",
      input: contextQa ? {
        nodeTask: "调用 $imagegen 生成两张配图并返回实际文件路径",
        relevantContext: { articleTitle: "前一轮帖子" },
        contextRefs: contextRef ? [{ ref: contextRef, title: "前一轮完整帖子", summary: "前一轮完整帖子", reason: "图片必须对应上一轮正文" }] : [],
        requirements: ["必须生成两张真实图片", "不得只返回提示词"],
        expectedArtifacts: [{ type: "image", count: 2, description: "工作区内可访问的 PNG 文件" }],
      } : {
        nodeTask: "work",
        relevantContext: { source: "root" },
        contextRefs: [],
        requirements: ["preserve original request"],
        expectedArtifacts: [],
      },
      reason: "start worker",
    });
    const status = dispatched?.run?.status;
    if (["waiting_approval", "waiting_user", "failed", "cancelled"].includes(status)) {
      completeTurn(turnId);
      return;
    }
  }
  await callMcpTool(turn.graphUrl, "hippo_complete_graph_run", {
    output: { result: contextQa ? "Blueprint context complete" : "Blueprint complete" },
    reason: "worker completed",
  });
  completeTurn(turnId);
}

async function callMcpTool(url, name, args) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-03-26",
  };
  const initialized = await postMcp(url, headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-codex", version: "1.0.0" } },
  });
  headers["Mcp-Session-Id"] = initialized.sessionId;
  await postMcp(url, headers, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const called = await postMcp(url, headers, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const payload = called.message?.result;
  if (payload?.isError) throw new Error(payload.content?.[0]?.text || `${name} failed`);
  const text = payload?.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : payload;
}

async function postMcp(url, headers, body) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`MCP request failed (${response.status}): ${await response.text()}`);
  const sessionId = response.headers.get("mcp-session-id") || headers["Mcp-Session-Id"] || "";
  const source = await response.text();
  if (!source) return { sessionId };
  const eventData = source.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
  const data = eventData || source;
  return { sessionId, message: data ? JSON.parse(data) : undefined };
}

function failTurn(turnId, error) {
  const turn = turns.get(turnId);
  if (!turn) return;
  send({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turnId, status: "failed", error: { message: error.message }, items: [] } } });
  turns.delete(turnId);
}

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

function responseFor(text, input = [], turnParams = {}, thread = {}) {
  if (text.includes("Blueprint_CONTEXT_QA") && text.includes("执行蓝图智能体节点")) {
    return JSON.stringify({
      originalRequest: text.includes('"task": "Blueprint_CONTEXT_QA 为文章生成两张配图"'),
      nodeTask: text.includes("调用 $imagegen 生成两张配图并返回实际文件路径"),
      relevantContext: text.includes('"articleTitle": "前一轮帖子"'),
      contextRefs: text.includes("ctx://") && text.includes("图片必须对应上一轮正文"),
      requirements: text.includes("必须生成两张真实图片") && text.includes("不得只返回提示词"),
      expectedArtifacts: text.includes('"type": "image"') && text.includes('"count": 2'),
      availableSkills: text.includes("$imagegen") && text.includes("Image generation skill"),
    });
  }
  if (text.includes("INPUT_CAPTURE")) return JSON.stringify(input);
  if (text.includes("TURN_SPEC_CAPTURE")) return JSON.stringify({
    input,
    developerInstructions: thread.developerInstructions,
    approvalPolicy: turnParams.approvalPolicy,
    sandbox: thread.sandbox,
    mcpServers: thread.mcpServers,
  });
  if (text.includes("执行蓝图智能体节点")) return "worker result";
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
