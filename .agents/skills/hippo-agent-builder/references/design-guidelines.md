# Agent Blueprint Design Guidelines

## Contents

- Field semantics
- Choosing single or DAG
- Node design
- Topology and transitions
- Approval and RAG decisions
- Quality checklist
- Example DAG

## Field Semantics

- `$schema`: Canonical schema identifier returned by `hippo_get_agent_schema`.
- `schemaVersion`: Blueprint contract version. Use the live schema value.
- `version`: Stored Agent revision. Read-only; use as `expectedVersion` for edits.
- `description`: User-facing summary of the entire Agent.
- `systemPrompt`: Instructions shared by the Agent. Avoid repeating every worker prompt here.
- `rootNodeId`: Root coordinator node for DAG Agents.
- `nodes[].description`: External interface visible to RootAgent: when to call the node, accepted input, and expected output.
- `nodes[].systemPrompt`: Instructions used inside that worker runtime session.
- `nodes[].transitionInstruction`: Plain-language guidance shown to RootAgent with the node result.
- `edges`: Default acyclic topology, not a hard-coded conditional workflow.
- `runtimeApprovalPolicy`: Approval behavior for runtime commands.
- `resultApprovalPolicy`: Review required after a node completes.
- `rag`: Node-level RAG capability and retrieval ceiling.

## Choosing Single or DAG

Choose `single` when all are true:

- One role can own the task end to end.
- Separate context or permissions are unnecessary.
- Intermediate output does not need independent review.

Choose `dag` when at least one is true:

- Roles need isolated system prompts or sessions.
- Workers can run independently or in parallel.
- A reviewer must remain independent from the implementer.
- Different nodes require different approval or RAG policies.
- RootAgent needs to decide among workers based on intermediate results.

## Node Design

Create a node around a stable responsibility, not each procedural step. A good node interface states:

1. When RootAgent should dispatch it.
2. What input it expects.
3. What artifact or decision it returns.

Keep worker prompts imperative and bounded. Require structured sections only when downstream coordination benefits from them.

## Topology And Transitions

- Connect Root to normal entry workers.
- Add edges for likely next steps; RootAgent may still choose another valid node.
- Do not add cycles. A retry or return to an earlier prototype node is expressed in `transitionInstruction` and creates another NodeRun attempt at runtime.
- Express parallel possibilities as multiple outgoing edges when workers can start from the same state.
- Do not encode `all`, `any`, or threshold gates in edges.
- Leave edge `metadata` as `{}` unless a documented UI field is needed. It is not interpreted by the scheduler.

## Approval And RAG Decisions

- `runtimeApprovalPolicy: inherit` is the default.
- Use `on-request` when a node may need commands outside routine trusted actions.
- Use `never` only when the user explicitly accepts unattended execution.
- Use `resultApprovalPolicy: manual` for irreversible decisions, release approval, or subjective acceptance gates.
- Use `resultApprovalPolicy: none` for ordinary machine-to-machine handoffs.
- Enable RAG on the node that interprets domain knowledge, not globally by habit.

## Quality Checklist

- The Agent has one clear purpose.
- Every DAG node has a unique id and non-empty name.
- Root coordinates rather than duplicating workers.
- Every worker has an interface description and bounded system prompt.
- Every conditional handoff is understandable from transition instructions.
- Edges are acyclic and reference existing nodes.
- Approval policies match risk.
- RAG, Skill, and MCP declarations are justified and real.
- The live MCP validator accepts the final blueprint.

## Example DAG

```json
{
  "$schema": "https://hippo.local/schemas/agent-blueprint-v1.schema.json",
  "schemaVersion": 1,
  "type": "dag",
  "name": "Implementation Review",
  "description": "Implements a scoped change and independently reviews it.",
  "systemPrompt": "Preserve the requested scope and report evidence.",
  "skills": [],
  "mcpServers": [],
  "runtimeId": "codex",
  "rag": { "enabled": false, "topN": 4 },
  "rootNodeId": "root",
  "nodes": [
    {
      "id": "root",
      "kind": "task",
      "name": "Root",
      "description": "Coordinates implementation and review without doing worker tasks.",
      "systemPrompt": "Dispatch work, inspect results, and decide whether to retry or finish.",
      "transitionInstruction": "Dispatch implementation first, then independent review.",
      "runtimeApprovalPolicy": "inherit",
      "resultApprovalPolicy": "none",
      "rag": { "enabled": false, "topN": 4 },
      "skills": [],
      "mcpServers": [],
      "metadata": {}
    },
    {
      "id": "implementation",
      "kind": "task",
      "name": "Implementation",
      "description": "Accepts a scoped requirement and returns completed changes with test evidence.",
      "systemPrompt": "Implement only the requested change and run focused tests.",
      "transitionInstruction": "On success dispatch review; on a blocking ambiguity ask the user.",
      "runtimeApprovalPolicy": "inherit",
      "resultApprovalPolicy": "none",
      "rag": { "enabled": false, "topN": 4 },
      "skills": [],
      "mcpServers": [],
      "metadata": {}
    },
    {
      "id": "review",
      "kind": "task",
      "name": "Review",
      "description": "Accepts implementation evidence and returns blocking findings or approval.",
      "systemPrompt": "Review independently. Lead with concrete defects and verify tests.",
      "transitionInstruction": "Retry implementation for actionable blockers; otherwise complete.",
      "runtimeApprovalPolicy": "inherit",
      "resultApprovalPolicy": "manual",
      "rag": { "enabled": false, "topN": 4 },
      "skills": [],
      "mcpServers": [],
      "metadata": {}
    }
  ],
  "edges": [
    { "id": "root->implementation", "from": "root", "to": "implementation", "metadata": {} },
    { "id": "implementation->review", "from": "implementation", "to": "review", "metadata": {} }
  ],
  "executionPolicy": { "maxDecisions": 50 },
  "metadata": {}
}
```
