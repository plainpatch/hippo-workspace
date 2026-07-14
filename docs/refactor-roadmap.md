# Hippo Refactor Roadmap

## Requirement Understanding

Hippo is an Agent App shell and orchestration layer over agent runtimes. It should not be modeled as an AnythingLLM chat wrapper.

The app must support multiple runtimes through adapters. The current implementation target is Codex, with Claude, Hermes, and other runtimes left as adapter extensions.

Hippo owns an app system path. New workspaces are created under the app-managed `workspaces/` directory, not arbitrary user-selected filesystem roots. Runtime, app home, workspace path, knowledge path, and RAG provider are app settings.

Agents are global definitions. A workspace references the global agents it enables, and a conversation inside that workspace can switch between those enabled agents. Conversation history belongs to the workspace; individual messages may record which agent was used.

AnythingLLM is only a RAG provider dependency. It must not be the agent conversation runtime. The app should keep RAG behind a `RagProvider` abstraction so AnythingLLM can be replaced later.

The knowledge base is app-system-level. It uses a constrained two-level model:

- domain: workspace authorization boundary
- topic: domain subdivision mapped to a topic-level RAG workspace

Workspaces reference domains and optionally select topics. RAG and system MCP search must only retrieve from domains referenced by the current workspace; topic selection can narrow retrieval but cannot grant access.

## Current Code Drift

- Execution was centered on AnythingLLM workspace chat instead of a runtime adapter.
- Project records were named `agentWorkspaces` and treated as AnythingLLM-bound workspaces.
- Agent definitions carried `knowledgeRefs`, which made knowledge authorization agent-scoped instead of workspace-scoped.
- Knowledge paths allowed arbitrary nesting and had no explicit primary/secondary drawer metadata model.
- MCP exposed raw AnythingLLM tools but did not expose workspace-scoped system RAG APIs.
- App system paths were mostly environment variables and repo-local defaults, not an explicit settings boundary.

## Phase Targets

### Phase 1: Architectural Boundaries

- Add app settings for app home, runtime, workspace path, knowledge path, and RAG provider.
- Add `RuntimeAdapter` and register Codex as the first runtime.
- Add `RagProvider` and keep AnythingLLM behind it.
- Keep global agents independent from workspaces.
- Add workspace `agentIds`, `knowledgeDomainRefs`, and `knowledgeTopicRefs`.
- Make workspace knowledge authorization primary-drawer-scoped.
- Expose workspace-scoped MCP search APIs.
- Expose workspaces only through `/api/workspaces`; pre-beta project aliases are intentionally unsupported.

### Phase 2: Canonical Workspace Model

- Keep only `workspaces` and `workspaceId` in the pre-beta store and service protocol.
- Reject obsolete fields instead of migrating or aliasing them.
- Persist workspace-scoped conversations.
- Record selected agent per message.
- Keep Agent-level knowledge authorization out of UI, MCP, and store writes.

### Phase 3: Runtime Integration Hardening

- Support richer Codex sessions instead of one-shot `codex exec` only.
- Add Claude and Hermes runtime adapters.
- Add runtime capability descriptions and per-agent runtime constraints.
- Add runtime-level MCP/skill materialization.

### Phase 4: Knowledge Management

- Add first-class domain/topic metadata editing.
- Add topic filtering controls in chat and MCP.
- Add RAG provider replacement tests.
- Decide whether AnythingLLM remains a provider or is replaced by an internal index.

### Phase 5: Product Polish

- Improve settings UI.
- Add workspace creation/import flows under the app system path.
- Add agent switching history in workspace conversations.
- Add validation and diagnostics for runtime, MCP, skills, and RAG provider configuration.
