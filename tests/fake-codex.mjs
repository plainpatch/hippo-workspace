#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const outputFlag = args.findIndex((arg) => arg === "--output-last-message" || arg === "-o");
const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : "";
const input = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});
const resumeIndex = args.indexOf("resume");
const resumedSessionId = resumeIndex >= 0
  ? args.slice(resumeIndex + 1).find((arg) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(arg)) || ""
  : "";
const sessionId = resumedSessionId || "11111111-1111-4111-8111-111111111111";
const delayMs = input.includes("BLOCK") ? 15000 : input.includes("SLOW") ? 350 : 15;
const logPath = process.env.FAKE_CODEX_LOG;
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ args, input, sessionId, resumedSessionId })}\n`);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: sessionId });
emit({ type: "turn.started" });
await new Promise((resolve) => setTimeout(resolve, delayMs));
const text = `fake response: ${input.trim()}`;
emit({ type: "item.completed", item: { type: "agent_message", text } });
emit({ type: "turn.completed" });
if (outputPath) fs.writeFileSync(outputPath, text);
