# Hippo Agent MCP Workflow

## Read And Validate

1. `hippo_get_agent_schema`: Read the canonical JSON Schema and current `schemaVersion`.
2. `hippo_list_agents`: Find possible existing Agents before creating duplicates.
3. `hippo_get_agent`: Read a complete stored Agent and its revision `version`.
4. `hippo_validate_agent_graph`: Normalize and validate a candidate without persistence.

Validation includes JSON Schema and graph semantics such as Root references, edge references, duplicate edges, self-edges, and cycles.

The canonical persistence schema is standard JSON Schema, not an OpenAI Structured Outputs response schema. Generate a candidate normally and validate it with `hippo_validate_agent_graph`; do not assume it can be passed directly to a model `response_format` implementation that requires every property to be required.

## Create

Call `hippo_create_agent` with the validated blueprint. Omit server-owned fields:

- `id`
- `version`
- `createdAt`
- `updatedAt`

Read the created Agent afterward with `hippo_get_agent`.

## Edit

1. Read the Agent with `hippo_get_agent`.
2. Apply the requested changes to that exact blueprint.
3. Validate the full candidate.
4. Call `hippo_update_agent` with `agentId`, changed fields, and `expectedVersion` from step 1.
5. Read the updated Agent and verify that `version` increased by one.

On HTTP/MCP conflict status 409, another writer changed the Agent. Fetch the new revision and do not retry blindly.

## Delete

Use `hippo_delete_agent` only on explicit deletion requests. It rejects Agents still referenced by a workspace.

## Tool Availability Failure

If these MCP tools are absent, provide a canonical JSON blueprint suitable for import into the Hippo canvas. Do not claim it was validated or saved.
