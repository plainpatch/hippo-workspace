# Hippo Agent Builder Skill Evaluation

Evaluation date: 2026-07-14

## Scope

The evaluation covers whether `.agents/skills/hippo-agent-builder` can guide a model to:

- choose between a single Agent and a DAG Agent;
- produce an Agent Blueprint v1 instance accepted by Hippo;
- avoid inventing unavailable Skills, MCP servers, RAG access, or edge semantics;
- apply runtime and result approval policies at the correct boundary;
- use the MCP read, validate, create, view, and versioned edit workflow;
- avoid persistence for design-only requests.

## Iterations

### Round 1: minimal single Agent

Prompt: design a concise Chinese-to-English product-copy translator without supplied external capabilities.

Result:

- selected `type: single`;
- emitted no graph nodes or edges;
- left RAG disabled and capability lists empty;
- passed Agent Blueprint v1 validation.

No change was required.

### Round 2: parallel release review DAG

Prompt: implementation first, followed by independent security and QA review, with human approval of security results.

Result:

- selected a valid DAG topology and the correct manual result approval;
- incorrectly added `metadata.parallelGroup` to edges even though the scheduler does not interpret it;
- added persistence-status fields to top-level metadata that were not part of the Agent behavior.

Fix:

- added an explicit rule that edge metadata remains empty unless Hippo documents a display field;
- prohibited invented runtime semantics such as parallel groups, gates, priorities, and conditions;
- clarified that parallelism is represented by multiple outgoing edges and coordinated by RootAgent.

### Round 3: live MCP create and edit

The model was connected to an isolated Hippo service and asked first to create a single release-notes Agent, then to edit its output contract.

Result after iteration:

- read the live schema and existing Agent list;
- validated before creating;
- created and read back revision `1`;
- fetched the existing Agent before editing;
- updated with `expectedVersion: 1` and read back revision `2`;
- preserved `schemaVersion: 1` while the Agent revision increased.

The first attempt exposed that write-tool annotations were incomplete and the client treated calls as approval-sensitive. Read/write/destructive/idempotent annotations were added to the Agent MCP tools before rerunning successfully.

### Round 4: post-fix DAG regression

The Round 2 release workflow was regenerated after tightening the Skill.

Result:

- passed current JSON Schema and DAG semantic validation;
- used `root`, `implementation`, `security_review`, `qa`, and `release_readiness` nodes;
- represented independent reviews with two outgoing implementation edges;
- set only `security_review.resultApprovalPolicy` to `manual`;
- left RAG disabled and all Skill/MCP declarations empty;
- left every edge `metadata` object empty;
- did not write files or publish the design-only Agent.

## Automated Gates

`tests/agent-builder-skill.test.js` prevents drift between the Skill and the runtime contract. It checks the complete MCP workflow, publishing safety, concurrency guidance, topology rules, and validates the reference DAG using the current orchestrator.

`tests/agent-blueprint.test.js` verifies schema/revision separation, stale edit rejection, graph semantics, and an end-to-end Streamable HTTP MCP lifecycle covering schema, validate, create, view, update, and delete.

## Current Boundary

The builder is a project-level Codex Skill that creates Hippo Agent blueprints. Blueprint `skills` and custom `mcpServers` are capability declarations; Hippo must only include names supplied by the user or a future capability registry. Node-level RAG and the Root Hippo MCP have concrete runtime injection today, while arbitrary declared Skill/MCP materialization remains a separate runtime-adapter concern.
