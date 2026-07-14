---
name: hippo-agent-builder
description: Design, validate, create, and edit versioned Hippo Agent blueprints through Hippo MCP. Use when a user asks to build an Agent, turn a role or workflow into a single/DAG Agent, improve an existing Agent, add or reorganize Agent nodes, prompts, approvals, RAG, skills, MCP declarations, or review an Agent blueprint before publishing.
---

# Hippo Agent Builder

Build the smallest useful Hippo Agent blueprint, validate it against the live schema, and preserve user control over publishing.

## Workflow

1. Determine whether the request creates a new Agent, edits an existing Agent, or only requests a design/review.
2. Call `hippo_get_agent_schema` before drafting. Treat its `schema` and `schemaVersion` as authoritative.
3. For edits, call `hippo_get_agent` and retain its `id` and `version`. Never reconstruct an existing Agent from memory.
4. Gather only missing requirements that materially affect roles, topology, permissions, review gates, or RAG. Prefer a reasonable explicit assumption over a long questionnaire.
5. Design the blueprint using [references/design-guidelines.md](references/design-guidelines.md).
6. Call `hippo_validate_agent_graph`. Repair every validation failure before presenting or publishing.
7. Summarize the proposed roles, default topology, approval boundaries, RAG use, and assumptions. Show the canonical JSON when the user asks for it or when MCP publishing is unavailable.
8. Publish only when the user asked to create/update the Agent or confirms the reviewed draft:
   - Create with `hippo_create_agent`.
   - Update with `hippo_update_agent`, passing the exact `expectedVersion` read in step 3.
9. Call `hippo_get_agent` after publishing and report the stored Agent id, revision `version`, and schema version.

Read [references/mcp-workflow.md](references/mcp-workflow.md) when invoking tools or handling conflicts.

## Design Rules

- Use `type: single` when one role and one runtime session can complete the task. Do not create a DAG for cosmetic phases.
- Use `type: dag` when work benefits from isolated roles, parallel workers, different permissions, independent review, or explicit handoff artifacts.
- Keep `root` as the coordinator. Describe worker interfaces; do not make Root duplicate worker execution.
- Treat edges as the default topology. Put conditional routing, retry, user escalation, and completion guidance in `transitionInstruction`.
- Keep edge `metadata` empty unless Hippo explicitly supplies a supported display field. Do not invent runtime semantics such as `parallelGroup`, gates, priorities, or conditions in metadata.
- Give every worker a concrete `description`, scoped `systemPrompt`, and output expectation.
- Enable RAG only on nodes that may need workspace knowledge. Do not perform eager retrieval.
- Use the least permissive runtime approval policy consistent with the task. Use manual result approval only at meaningful human gates.
- Do not invent Skill or MCP names. Include only capabilities the user supplied or Hippo reports as available.
- Keep `schemaVersion` separate from revision `version`. Never send `id`, `version`, `createdAt`, or `updatedAt` when creating.
- Do not bypass validation by writing the Agent store or calling private HTTP endpoints.

## Publishing Safety

- A request such as “create this Agent” or “apply these edits” authorizes the corresponding write after successful validation.
- A request to “design”, “suggest”, “analyze”, or “show a draft” does not authorize publishing.
- If `hippo_update_agent` returns a version conflict, fetch the latest Agent, explain the conflicting fields, rebuild the change on the new revision, validate again, and ask before overwriting changed intent.
- If Hippo MCP is unavailable, return an importable blueprint and state clearly that it was not persisted.
- If working inside the Hippo repository without MCP, read `schemas/agent-blueprint-v1.schema.json` directly. Do not infer the contract by searching implementation code.
