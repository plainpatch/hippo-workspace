import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AGENT_BLUEPRINT_SCHEMA_ID,
  AGENT_BLUEPRINT_SCHEMA_VERSION,
  getAgentBlueprintSchema,
  validateAgentBlueprintSchema,
} from "../src/agent-blueprint-schema.js";
import { AgentOrchestrator, AgentOrchestratorError } from "../src/agent-orchestrator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Agent Blueprint v1 schema distinguishes schema and revision versions", async (t) => {
  const schema = getAgentBlueprintSchema();
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.ok(schema.definitions);
  assert.equal("$defs" in schema, false);

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-agent-schema-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "agents.json"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  const created = (await orchestrator.createAgent(singleBlueprint("Reviewer"))).agent;
  assert.equal(created.$schema, AGENT_BLUEPRINT_SCHEMA_ID);
  assert.equal(created.schemaVersion, AGENT_BLUEPRINT_SCHEMA_VERSION);
  assert.equal(created.version, 1);
  assert.equal(validateAgentBlueprintSchema(created).valid, true);
  await assert.rejects(
    orchestrator.updateAgent(created.id, { description: "Unsafe unversioned edit" }),
    /expectedVersion/
  );

  const updated = (await orchestrator.updateAgent(created.id, {
    expectedVersion: 1,
    description: "Reviews changes and reports blocking issues.",
  })).agent;
  assert.equal(updated.schemaVersion, 1);
  assert.equal(updated.version, 2);
  await assert.rejects(
    orchestrator.updateAgent(created.id, { expectedVersion: 1, name: "Stale edit" }),
    (error) => error instanceof AgentOrchestratorError
      && error.status === 409
      && error.details.actualVersion === 2
  );

  const workspace = (await orchestrator.createWorkspace({
    name: "Agent consumer",
    agentIds: [created.id],
  })).workspace;
  await assert.rejects(
    orchestrator.deleteAgent(created.id),
    (error) => error instanceof AgentOrchestratorError
      && error.status === 409
      && error.details.workspaceIds.includes(workspace.id)
  );
});

test("Agent Blueprint v1 rejects invalid graph semantics", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-agent-graph-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(home, "agents.json"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  const created = (await orchestrator.createAgent(multiNodeBlueprint("Partial update"))).agent;
  const partiallyUpdated = (await orchestrator.updateAgent(created.id, {
    expectedVersion: created.version,
    description: "Only this field changes.",
  })).agent;
  assert.equal(partiallyUpdated.type, "blueprint");
  assert.equal(partiallyUpdated.nodes.length, 2);
  assert.equal(partiallyUpdated.edges.length, 1);

  const blueprint = multiNodeBlueprint("Cycle");
  blueprint.edges.push({ id: "worker->root", from: "worker", to: "root", metadata: {} });
  assert.throws(() => orchestrator.validateAgent(blueprint), /cycle/i);

  const disconnected = multiNodeBlueprint("Disconnected");
  disconnected.nodes.push({
    ...disconnected.nodes[1],
    id: "orphan",
    name: "Orphan",
  });
  assert.throws(() => orchestrator.validateAgent(disconnected), /unreachable from root/i);

  const invalidRag = multiNodeBlueprint("Invalid RAG");
  invalidRag.rag.topN = 0;
  assert.throws(() => orchestrator.validateAgent(invalidRag), />=1/i);

  const invalidExecution = multiNodeBlueprint("Invalid execution policy");
  invalidExecution.executionPolicy.maxDecisions = 1001;
  assert.throws(() => orchestrator.validateAgent(invalidExecution), /<=1000/i);

  const duplicateMcp = multiNodeBlueprint("Duplicate MCP");
  duplicateMcp.nodes[1].mcpServers = ["hippo", "hippo"];
  assert.throws(() => orchestrator.validateAgent(duplicateMcp), /must be unique/i);
});

test("Agent REST and MCP support schema, validate, create, view, versioned edit, and delete", { timeout: 15000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-agent-mcp-test-"));
  const port = await getFreePort();
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WRAPPER_PORT: String(port),
      HIPPO_APP_HOME: home,
      RESOURCE_ROOT_PATH: home,
      HIPPO_DATABASE_PATH: path.join(home, "agents.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
    await fs.rm(home, { recursive: true, force: true });
  });
  await poll(async () => {
    if (server.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    return fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.ok).catch(() => false);
  });

  const schemaResponse = await fetch(`http://127.0.0.1:${port}/api/agents/schema`).then((response) => response.json());
  assert.equal(schemaResponse.schema.$id, AGENT_BLUEPRINT_SCHEMA_ID);

  const restCreated = await jsonRequest(port, "/api/agents", {
    method: "POST",
    body: singleBlueprint("REST Agent"),
  });
  const restViewed = await jsonRequest(port, `/api/agents/${restCreated.agent.id}`);
  assert.equal(restViewed.agent.version, 1);
  const restEdited = await jsonRequest(port, `/api/agents/${restCreated.agent.id}`, {
    method: "PATCH",
    body: { expectedVersion: 1, description: "Updated through REST" },
  });
  assert.equal(restEdited.agent.version, 2);
  assert.equal(restEdited.agent.description, "Updated through REST");
  const restDeleted = await jsonRequest(port, `/api/agents/${restCreated.agent.id}`, { method: "DELETE" });
  assert.equal(restDeleted.deleted, true);

  const client = new Client({ name: "hippo-agent-mcp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "hippo_get_agent_schema",
    "hippo_validate_agent_graph",
    "hippo_create_agent",
    "hippo_get_agent",
    "hippo_update_agent",
    "hippo_delete_agent",
  ]) assert.ok(tools.includes(name), `${name} was not registered`);

  const schema = parseToolResult(await client.callTool({ name: "hippo_get_agent_schema", arguments: {} }));
  assert.equal(schema.schemaVersion, 1);
  const candidate = multiNodeBlueprint("Delivery Agent");
  const validation = parseToolResult(await client.callTool({
    name: "hippo_validate_agent_graph",
    arguments: candidate,
  }));
  assert.equal(validation.valid, true);

  const created = parseToolResult(await client.callTool({ name: "hippo_create_agent", arguments: candidate })).agent;
  const viewed = parseToolResult(await client.callTool({
    name: "hippo_get_agent",
    arguments: { agentId: created.id },
  })).agent;
  assert.equal(viewed.version, 1);
  assert.equal(viewed.schemaVersion, 1);

  const edited = parseToolResult(await client.callTool({
    name: "hippo_update_agent",
    arguments: { agentId: created.id, expectedVersion: 1, description: "Updated by MCP" },
  })).agent;
  assert.equal(edited.description, "Updated by MCP");
  assert.equal(edited.version, 2);

  const deleted = parseToolResult(await client.callTool({
    name: "hippo_delete_agent",
    arguments: { agentId: created.id },
  }));
  assert.equal(deleted.deleted, true);
});

function singleBlueprint(name) {
  return {
    $schema: AGENT_BLUEPRINT_SCHEMA_ID,
    schemaVersion: 1,
    type: "single",
    name,
    description: "",
    systemPrompt: "Review the requested work.",
    skills: [],
    mcpServers: [],
    runtimeId: "codex",
    rag: { enabled: false, topN: 4 },
    rootNodeId: "",
    nodes: [],
    edges: [],
    executionPolicy: { maxDecisions: 50 },
    metadata: {},
  };
}

function multiNodeBlueprint(name) {
  const node = (id, nodeName) => ({
    id,
    kind: "task",
    name: nodeName,
    description: `${nodeName} interface`,
    systemPrompt: `Act as ${nodeName}.`,
    transitionInstruction: "Continue through the default topology when successful.",
    runtimeApprovalPolicy: "inherit",
    resultApprovalPolicy: "none",
    rag: { enabled: false, topN: 4 },
    skills: [],
    mcpServers: [],
    metadata: {},
  });
  return {
    ...singleBlueprint(name),
    type: "blueprint",
    rootNodeId: "root",
    nodes: [node("root", "Root"), node("worker", "Worker")],
    edges: [{ id: "root->worker", from: "root", to: "worker", metadata: {} }],
  };
}

function parseToolResult(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function jsonRequest(port, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function poll(operation, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await operation();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for condition.");
}
