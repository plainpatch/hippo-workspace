import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentOrchestrator } from "../src/agent-orchestrator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repoRoot, ".agents", "skills", "hippo-agent-builder");

test("Hippo Agent Builder skill documents the complete versioned MCP workflow", async () => {
  const [skill, workflow, guidelines, openai] = await Promise.all([
    fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    fs.readFile(path.join(skillRoot, "references", "mcp-workflow.md"), "utf8"),
    fs.readFile(path.join(skillRoot, "references", "design-guidelines.md"), "utf8"),
    fs.readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8"),
  ]);

  for (const tool of [
    "hippo_get_agent_schema",
    "hippo_validate_agent_graph",
    "hippo_create_agent",
    "hippo_get_agent",
    "hippo_update_agent",
    "hippo_delete_agent",
  ]) assert.match(`${skill}\n${workflow}`, new RegExp(`\\b${tool}\\b`));

  assert.match(skill, /expectedVersion/);
  assert.match(skill, /does not authorize publishing/);
  assert.match(skill, /Do not invent Skill or MCP names/);
  assert.match(guidelines, /Do not encode `all`, `any`, or threshold gates/);
  assert.match(guidelines, /Leave edge `metadata` as `\{\}`/);
  assert.match(openai, /Hippo Agent Builder/);
  assert.doesNotMatch(`${skill}\n${workflow}\n${guidelines}`, /\bTODO\b/i);
});

test("Hippo Agent Builder reference Blueprint is accepted by the current live contract", async () => {
  const guidelines = await fs.readFile(path.join(skillRoot, "references", "design-guidelines.md"), "utf8");
  const jsonBlock = guidelines.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(jsonBlock, "design guidelines must contain a canonical JSON example");

  const blueprint = JSON.parse(jsonBlock[1]);
  const orchestrator = new AgentOrchestrator({
    databasePath: path.join(repoRoot, ".unused-agent-builder-test.json"),
    runtimeRegistry: {},
    ragProvider: {},
    settings: {},
  });
  const result = orchestrator.validateAgent(blueprint);
  assert.equal(result.valid, true);
  assert.equal(result.agent.schemaVersion, 1);
  assert.equal(result.agent.rootNodeId, "root");
});
