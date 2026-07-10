# RootAgent Runtime

## Ownership

For a graph agent, the RootAgent is the only scheduling decision maker. It owns the full view of the frozen agent prototype and the current runtime graph. The graph store remains the durable source of truth; model context is never the only copy of run state.

- The agent prototype contains a Root node, worker nodes, default edges, prompts, one optional transition instruction per node, and execution/result approval policies.
- The Root node maps to the persistent Hippo conversation and Codex root session.
- Each worker execution creates a new append-only NodeRun attempt and an isolated runtime session.
- Returning to or retrying a prototype node creates a new NodeRun instead of resetting history.

## Prototype

Default edges describe the normal path, not an automatic workflow engine. There are no all/any/threshold gates, required edges, or serial/parallel edge types. A node's `transitionInstruction` is a plain-language result handling rule consumed by RootAgent after the node finishes.

```json
{
  "id": "review",
  "description": "Reviews an implementation and returns blocking issues and a release recommendation.",
  "systemPrompt": "Review the implementation.",
  "transitionInstruction": "If blocking issues exist, dispatch development again; if information is missing, request the user; otherwise complete the run.",
  "runtimeApprovalPolicy": "inherit",
  "resultApprovalPolicy": "manual"
}
```

`description` is the node's external interface description shown to RootAgent. `systemPrompt` controls the worker session itself. `transitionInstruction` is the result handling rule shown to RootAgent together with the completed NodeRun output so it can choose the next graph action.

## Node RAG Tool

RAG is an optional node capability, not an eager execution mode. Each node owns `rag.enabled` and `rag.topN`. When enabled, Hippo injects a dedicated read-only MCP server into that node session with only `hippo_rag_scope` and `hippo_rag_search`. The model decides whether retrieval is needed, while the server enforces the current workspace authorization boundary and the node's configured Top N. Disabled nodes receive no RAG MCP server. AnythingLLM remains only the retrieval provider.

## Runtime Loop

1. Create an AgentRun with a frozen prototype, Root coordinator state, and an empty runtime graph.
2. Resume RootAgent with the original task, prototype, NodeRun inputs/outputs/errors, transition instructions, and user responses.
3. RootAgent calls a Hippo Graph Tool.
4. Dispatch creates a new NodeRun attempt and executes it in an isolated runtime session.
5. A completed or failed NodeRun is persisted before RootAgent is resumed.
6. Manual result approval pauses the run before RootAgent can continue.
7. User requests pause the same run; the next user message resumes the same Root session and Run.
8. The loop ends only through complete, fail, cancel, approval wait, or user wait.

## Graph Tools

- `hippo_get_agent_run`
- `hippo_dispatch_graph_node`
- `hippo_request_graph_user`
- `hippo_resume_graph_with_user_input`
- `hippo_complete_graph_run`
- `hippo_fail_graph_run`
- `hippo_retry_node_run`
- `hippo_resume_node_run`
- `hippo_cancel_agent_run`

Codex Root sessions receive only the local Hippo MCP server through runtime configuration. The Root runtime uses an isolated Codex config with an explicit model so unrelated user MCP servers do not enter the coordinator context. JSON decisions remain a fallback protocol for future runtime adapters that cannot call MCP tools natively.

## State

Run states: `pending`, `coordinating`, `running`, `waiting_approval`, `waiting_user`, `completed`, `failed`, `cancelled`.

NodeRun states: `pending`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`.

Graph Tool methods validate node ids, allocate attempts under the store lock, reject updates to terminal runs, preserve every attempt, and append trace events for decisions and state transitions.
