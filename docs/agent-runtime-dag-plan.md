# Agent Runtime and DAG Orchestration Plan

> Superseded for graph execution by [root-agent-runtime.md](./root-agent-runtime.md). This file remains as historical context; automatic ready-node scheduling, wait nodes, edge success rules, and serial/parallel edge types are no longer the target architecture.

## Objective

Hippo must evolve from a single `codex exec` wrapper into a workspace-scoped agent orchestration system. The system must separate agent prototypes from runtime execution state, support Codex session reuse, and provide a DAG orchestration layer that can be exposed as a stateful tool.

## Requirements

### Workspace and Root Session

- A Hippo workspace owns local filesystem scope, enabled agents, knowledge library refs, and topic filters.
- A Hippo root session is the user-facing conversation container.
- A root session has `type: "root"` and is the only session type allowed to own graph run state.
- A root session may contain multiple agent runs.
- A root session may map to runtime sessions, including a Codex root session.
- A root session always resumes its mapped runtime session after the first turn.
- A root session can switch active agent inside the same conversation; the user owns the semantic risk of inherited context.
- Every message must record the agent/runtime context used for that turn when available.

### Agent Prototype

- Agent definitions are static user-authored prototypes.
- Agent definitions must support two shapes:
  - `single`: prompt + skills + MCP + runtime + RAG defaults.
  - `dag`: root node + nodes + edges + execution policy.
- Agent definitions must be versioned.
- A DAG agent prototype must not contain runtime session ids, node outputs, trace, or status.
- A run must snapshot the agent definition/version used at run creation.

### Runtime Graph

- An `AgentRun` is one execution instance under a root session.
- An `AgentRun` contains runtime graph state and a frozen agent snapshot.
- A `NodeRun` is one executable node instance.
- A `NodeRun` owns input, output, status, trace, and runtime session mapping.
- A `NodeRun` does not own the full graph; it belongs to the root run.
- Each Codex DAG node should map to one Codex runtime session by default.
- Serial and parallel nodes must be scheduled by a deterministic root controller.

### Graph Orchestration Tool

- Graph orchestration should be exposed as a stateful API/MCP tool.
- The model can propose agent prototypes or graph patches.
- The tool must validate and persist canonical graph state.
- The tool, not the model context, is the source of truth for run status.
- The tool must support create, read, update, validate, run, advance, cancel, retry, and trace operations.

### Codex Runtime Adapter

- Codex must be treated as a runtime provider, not as the Hippo session store.
- Hippo session id remains the primary id.
- Codex session id is runtime metadata.
- First turn should create a Codex session with workspace path.
- Later turns should resume the Codex session when possible.
- DAG worker nodes start isolated Codex sessions; the Root conversation always resumes its mapped session.
- The adapter should prefer `codex exec --json` so Hippo can consume structured runtime events.
- The adapter must support cancellation by run id / process id.

## Data Model

### RootSession

```ts
type RootSession = {
  id: string;
  type: "root";
  workspaceId: string;
  title: string;
  activeAgentId?: string;
  messages: Message[];
  runIds: string[];
  runtimeSessions: Record<string, RuntimeSessionRef>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

### RuntimeSessionRef

```ts
type RuntimeSessionRef = {
  provider: "codex" | "claude" | "hermes";
  sessionId: string;
  resumedFromSessionId?: string;
  workspacePath: string;
  hippoSessionId: string;
  status: "active" | "ephemeral" | "archived" | "unknown";
  runtimeOptions?: {
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  };
  createdAt: string;
  updatedAt: string;
};
```

### AgentDefinition

```ts
type AgentDefinition = {
  id: string;
  version: number;
  type: "single" | "dag";
  name: string;
  description?: string;
  systemPrompt?: string;
  skills?: SkillDefinition[];
  mcpServers?: string[];
  runtimeId?: string;
  rag?: RagDefaults;
  rootNodeId?: string;
  nodes?: AgentNodeDefinition[];
  edges?: AgentEdgeDefinition[];
  metadata?: Record<string, unknown>;
};
```

### AgentRun

```ts
type AgentRun = {
  id: string;
  rootSessionId: string;
  workspaceId: string;
  agentId: string;
  agentVersion: number;
  agentSnapshot: AgentDefinition;
  status: "pending" | "running" | "waiting_user" | "waiting_approval" | "completed" | "failed" | "cancelled";
  input: unknown;
  output?: unknown;
  error?: unknown;
  nodeRuns: Record<string, NodeRun>;
  trace: TraceEvent[];
  createdAt: string;
  updatedAt: string;
};
```

### NodeRun

```ts
type NodeRun = {
  id: string;
  type: "node";
  runId: string;
  nodeId: string;
  agentId?: string;
  status: "pending" | "ready" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  runtimeSession?: RuntimeSessionRef;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  upstreamNodeIds: string[];
  downstreamNodeIds: string[];
  trace: TraceEvent[];
  createdAt: string;
  updatedAt: string;
};
```

## Implementation Phases and Gates

Status as of the current implementation:

- Phase 1: implemented. Hippo root conversations store runtime session refs, and Codex JSON events are captured when available.
- Phase 2: implemented. Runtime events are normalized, executions carry `runId`, and active runtime processes can be cancelled.
- Phase 3: implemented. Agent definitions are versioned and support `single` and `dag` prototypes with DAG validation and acyclicity checks.
- Phase 4: implemented. Every execution creates a persistent `AgentRun`; `single` agents create one `NodeRun`, and DAG agents expand to one `NodeRun` per prototype node.
- Phase 5: implemented for automatic execution. DAG runs expand deterministically, ready nodes are scheduled by dependency order, parallel branches use independent runtime sessions, and terminal outputs are collected into the run output.
- Phase 6: implemented as a first stateful API/MCP surface. Tools can validate graph prototypes, create/read/advance/cancel/retry runs, inspect node runs, and append/list trace events.
- Workspace RAG scope planning is implemented as API/MCP. A model can first read the authorized knowledge domains/topics, then call scoped search against topic-level RAG workspaces. Search requests are intersected with the workspace's configured knowledge authorization.
- Topic-level RAG synchronization is implemented as API/UI/MCP. Hippo scans second-level topic folders, uploads new or changed files to the mapped AnythingLLM workspace, stores returned document names, and refreshes embeddings before retrieval.
- Codex session mapping records the runtime session for each Hippo conversation. Later turns always resume that Codex session.
- Main app conversations persist message-level run metadata, including workspace id, agent/runtime selection, run id, and status.
- Single-turn Codex sandbox overrides are supported from UI/API/MCP and are recorded in request/message/runtime metadata.
- Codex JSONL streaming is normalized so structured runtime events remain trace data while extracted text deltas are streamed to the chat surface.

Remaining product hardening:

- Task nodes can require result approval and resume from `waiting_approval`; requesting user guidance is represented by the graph run's `waiting_user` state.
- Optional edge semantics are basic: failed optional upstream nodes do not block downstream readiness, while required failed branches fail the run.
- UI graph editing has a lightweight node/edge builder backed by JSON. It is not yet a full canvas-style visual graph editor.
- Trace querying is stored in the JSON run store; larger deployments should move this to an indexed run store.
- RAG retrieval is currently a fan-out over topic workspaces with merged results; a later retrieval planner can add ranking over domain/topic metadata before issuing searches.

### Phase 1: Codex Session Runtime Foundation

Implementation:
- Add root session metadata to conversations.
- Add runtime session mapping to conversations.
- Update Codex adapter to support JSONL events via `codex exec --json`.
- Extract and persist Codex session id when emitted by Codex.
- Resume Codex session on later turns when a session id exists.
- Mark a runtime session as ephemeral when Codex does not emit a session id.

Checkpoints:
- New conversations have `type: "root"` and `runtimeSessions`.
- Runtime results include `runtimeSession`.
- Stored conversation metadata receives `runtimeSessions.codex.sessionId` when available.
- New conversations persist the canonical runtime session shape.

Gate:
- `npm run check` passes.
- API dry run still works.
- A real Codex execution either persists a session id or marks the runtime session as `ephemeral`.

### Phase 2: Runtime Event Model and Cancellation

Implementation:
- Normalize Codex JSONL events into Hippo runtime events.
- Add `runId` to runtime executions.
- Maintain an in-memory process registry.
- Add cancel endpoint / tool.

Checkpoints:
- UI receives structured events.
- Cancelling a running execution terminates the child process and emits `cancelled`.

Gate:
- Long-running test task can be cancelled.
- No orphan Codex process remains after cancel.

### Phase 3: Agent Prototype Versioning

Implementation:
- Add `type`, `version`, `rag`, `nodes`, and `edges` fields to agent definitions.
- Agent definitions use an explicit `single` or `dag` type and version.
- Validate DAG shape and acyclicity.

Checkpoints:
- Single-node agents execute through the same versioned prototype contract.
- DAG prototype can be created, read, updated, and validated.

Gate:
- Invalid DAG with cycle is rejected.
- UI and API use the canonical agent prototype fields.

### Phase 4: AgentRun and NodeRun Runtime Graph

Implementation:
- Add persistent run store.
- Add `GraphRunController`.
- Single-node execution is represented as one `AgentRun` with one `NodeRun`.
- NodeRun binds to a runtime session.

Checkpoints:
- Every task creates an AgentRun.
- NodeRun stores input, output, status, runtime session, and trace.

Gate:
- Single-node execution produces the same user-visible result as before.
- Run and node details are retrievable by API.

### Phase 5: Serial and Parallel DAG Scheduling

Implementation:
- Expand DAG snapshot to NodeRuns.
- Implement dependency resolution.
- Implement serial execution.
- Implement parallel execution with bounded concurrency.
- Merge upstream outputs for downstream nodes.

Checkpoints:
- Ready nodes are deterministic.
- Parallel branches create independent runtime sessions.
- Terminal node output becomes run output.

Gate:
- Serial DAG executes in dependency order.
- Parallel DAG executes independent branches without sharing Codex session.
- Failed required node fails run.

### Phase 6: Stateful Graph Orchestration Tool

Implementation:
- Expose graph APIs and MCP tools:
  - create/update/validate agent graph
  - create/get/advance/cancel/retry run
  - get node run
  - append/list trace
- Ensure tools mutate persisted canonical state only through validated transitions.

Checkpoints:
- LLM can create a graph prototype through tool calls.
- LLM can inspect and advance a run through tool calls.

Gate:
- Tool state survives service restart.
- Invalid state transitions are rejected.

## Near-Term Development Order

1. Implement Phase 1 in current codebase.
2. Use `/api/workspaces` as the only workspace API.
3. Add internal metadata first; defer UI visualization until runtime state is reliable.
4. Add cancellation only after runtime run ids and process registry exist.
