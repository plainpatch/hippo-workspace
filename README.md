# hippo

Hippo is an Agent App shell for workspace-scoped agent orchestration. It is designed to adapt agent runtimes such as Codex, Claude, or Hermes; the current runtime adapter is Codex. AnythingLLM is used only as the current RAG provider and is intentionally hidden behind a provider abstraction.

See [docs/refactor-roadmap.md](docs/refactor-roadmap.md) for the active requirement alignment, current code drift, and phased refactor targets.

## Start AnythingLLM

```sh
cp .env.example .env
cp anythingllm/server.env.example anythingllm/server.env
mkdir -p anythingllm/storage
docker compose up -d
```

Open http://localhost:3001.

AnythingLLM data is persisted in `anythingllm/storage`, and server-side AnythingLLM environment overrides live in `anythingllm/server.env`.

## Configure the wrapper

AnythingLLM's developer API requires an API key.

1. Open http://localhost:3001.
2. Create an AnythingLLM API key from the AnythingLLM settings UI.
3. Put it in `.env`:

```sh
ANYTHINGLLM_API_KEY=your-anythingllm-api-key
```

Restart the wrapper after changing the key:

```sh
docker compose up -d --build rag-wrapper
```

Open the wrapper console at http://localhost:8787.

The console supports:

- creating Hippo workspaces under the app system path
- creating global Agent definitions
- enabling global Agents per workspace
- assigning knowledge libraries and topic filters to workspaces
- ingesting raw text and files into the system knowledge base
- workspace-scoped chat through the configured runtime
- workspace-scoped RAG search through the configured RAG provider

## Resource directory model

The app uses one system resource root, configurable through app settings and environment variables:

```text
~/.hippo/
  projects/    # one local directory per Hippo workspace
  knowledge/   # system-level knowledge drawers
  agents/      # global agent and workspace store
```

When a workspace is created, Hippo creates a folder under the app-managed `projects/` directory. Workspaces reference global agents, first-level knowledge libraries, and optional second-level topic filters.

The knowledge base is system-level. It uses a controlled drawer model under `knowledge/`: first-level drawers are authorization boundaries, while second-level drawers are topic filters mapped to topic-level RAG workspaces. Workspaces do not own those files directly. A workspace grants RAG access by listing first-level drawers in `knowledgeDrawerRefs` and can narrow retrieval with `knowledgeTopicRefs`.

The Docker wrapper mounts the resource root at `/app/resources`:

```yaml
./resources:/app/resources
```

## Run as a local desktop app

This repository includes an Electron desktop shell for macOS, Windows, and Linux development builds. It reuses the same local wrapper service and UI.

```sh
npm install
npm run desktop
```

The desktop shell checks `http://127.0.0.1:8787/api/health`. If the wrapper is not already running, it starts `src/server.js` as a local sidecar and opens the Agent Console window.

Runtime dependencies are still local:

- AnythingLLM at `ANYTHINGLLM_BASE_URL`
- `ANYTHINGLLM_API_KEY` in `.env`
- Ollama for local embeddings when using the configured `bge-m3:latest` embedding model

## Chrome extension

The companion Chrome extension lives in `apps/chrome-extension`. It opens as a Chrome side panel, loads Hippo workspaces, provides a workspace-scoped chat surface, and clips the current page or selected text into the Hippo system knowledge base.

One-click developer install:

```sh
npm run install:chrome-extension
```

This validates the extension and starts Chrome, Edge, or Chromium with a dedicated local profile at `.chrome-extension-profile` and the unpacked extension loaded. It does not modify your primary browser profile.

Manual install:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select `apps/chrome-extension`.

Default connection:

```text
http://localhost:8787
```

Side panel capabilities:

- select and load a Hippo workspace
- chat with the selected workspace's agent
- pass the current page title and URL as runtime context during chat
- read the current page title, URL, selected text, and page text summary
- save content into `resources/knowledge/<目录>`
- optionally associate the knowledge directory with a Hippo workspace
- open the local Hippo workbench

Context menu:

- select text on a page
- right click
- choose "保存选中文本到 Hippo 知识库"

The context menu uses the default knowledge directory and default workspace selected in the side panel.

## Run the wrapper locally without Docker

```sh
npm install
npm start
```

The local server reads `ANYTHINGLLM_BASE_URL`, `ANYTHINGLLM_API_KEY`, and `WRAPPER_PORT` from `.env`.

## MCP server

The MCP wrapper runs over stdio:

```sh
npm run mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "anythingllm-rag": {
      "command": "node",
      "args": ["/path/to/hippo/src/mcp-server.js"],
      "env": {
        "ANYTHINGLLM_BASE_URL": "http://localhost:3001",
        "ANYTHINGLLM_API_KEY": "your-anythingllm-api-key"
      }
    }
  }
}
```

When the wrapper HTTP service is running, it also exposes a stateless Streamable HTTP MCP endpoint:

```text
http://localhost:8787/mcp
```

Exposed MCP tools:

- `hippo_get_settings`
- `hippo_list_workspaces`
- `hippo_create_workspace`
- `hippo_get_workspace`
- `hippo_update_workspace`
- `hippo_list_agents`
- `hippo_create_agent`
- `hippo_get_agent`
- `hippo_workspace_knowledge`
- `hippo_sync_knowledge_topic`
- `hippo_workspace_rag_plan`
- `hippo_workspace_rag_search`
- `hippo_execute_workspace_task`

## Agent orchestration layer

The wrapper separates workspaces from agents:

- workspace: name, description, app-managed local directory, enabled global agents, authorized first-level knowledge libraries, and selected topic filters
- agent: name, description, system prompt, runtime, skills, MCP access, and optional extra RAG document names
- task execution: runs inside a selected workspace and may load one workspace-enabled agent for that turn

Create a workspace:

```sh
curl -X POST http://localhost:8787/api/workspaces \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "docs-workspace",
    "description": "Documentation workspace",
    "agentIds": ["<agent-id>"],
    "knowledgeDrawerRefs": ["platform"],
    "knowledgeTopicRefs": ["platform/api-docs"]
  }'
```

Create an agent:

```sh
curl -X POST http://localhost:8787/api/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "docs-agent",
    "description": "Answers from selected documentation knowledge",
    "systemPrompt": "Only answer from the configured knowledge base. Say when evidence is missing.",
    "skills": [
      {
        "name": "summarize",
        "description": "Summarize retrieved technical material into concise action items."
      }
    ],
    "mcpServers": ["hippo-system"],
    "runtimeId": "codex",
    "ragDocumentNames": ["custom-documents/example.json"],
    "defaultMode": "query",
    "topN": 4
  }'
```

Create a system knowledge folder:

```sh
curl -X POST http://localhost:8787/api/knowledge/folders \
  -H 'Content-Type: application/json' \
  -d '{ "path": "platform/anythingllm", "description": "AnythingLLM integration docs" }'
```

Ingest text into the system knowledge base:

```sh
curl -X POST http://localhost:8787/api/knowledge/text \
  -H 'Content-Type: application/json' \
  -d '{
    "relativeDir": "platform/anythingllm",
    "title": "接入说明",
    "textContent": "AnythingLLM 接入说明..."
  }'
```

Sync a second-level topic folder into its mapped RAG workspace:

```sh
curl -X POST http://localhost:8787/api/knowledge/topics/sync \
  -H 'Content-Type: application/json' \
  -d '{
    "topicPath": "platform/anythingllm"
  }'
```

This scans files under the Hippo topic folder, uploads new or changed files to the topic-level AnythingLLM workspace, records returned document names in the Hippo knowledge index, and refreshes workspace embeddings.

Plan a workspace-scoped RAG retrieval before searching:

```sh
curl -X POST http://localhost:8787/api/workspaces/<workspace-id>/rag-plan \
  -H 'Content-Type: application/json' \
  -d '{
    "drawerRefs": ["platform"],
    "topicRefs": ["platform/anythingllm"]
  }'
```

The plan endpoint returns only the intersection of the requested scope and the workspace authorization. First-level knowledge libraries are the authorization boundary; second-level topics are filters mapped to topic-level RAG workspaces.

Search the selected RAG scope:

```sh
curl -X POST http://localhost:8787/api/workspaces/<workspace-id>/rag-search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "AnythingLLM workspace 如何更新向量索引？",
    "topicRefs": ["platform/anythingllm"],
    "topN": 4
  }'
```

Execute a task in a workspace and load an agent for this turn:

```sh
curl -X POST http://localhost:8787/api/workspaces/<workspace-id>/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "<agent-id>",
    "task": "根据知识库说明这个模块的接入步骤。",
    "mode": "query",
    "sessionId": "<hippo-conversation-id>",
    "contextStrategy": "runtime",
    "sandboxMode": "workspace-write"
  }'
```

Hippo conversations are root sessions. For the Codex runtime, Hippo stores the Codex session id under `conversation.runtimeSessions.codex.sessionId` and resumes it on later turns by default. `contextStrategy` controls this behavior:

- `runtime`: keep Codex's runtime-managed multi-turn context.
- `reset`: start a fresh Codex runtime session for the turn.
- `manual-summary`: start a fresh Codex runtime session and inject `contextSummary` into the prompt as the compressed prior context.

`sandboxMode` can override the default Codex sandbox for one turn. Supported values are `read-only`, `workspace-write`, and `danger-full-access`.

Workspace and agent definitions are persisted under the configured app home, by default `~/.hippo/agents/agent-store.json`.

## Stop

```sh
docker compose down
```

## Local model providers

AnythingLLM is configured for:

- chat model: `deepseek-v3.2` through the configured OpenAI-compatible gateway
- embedding model: local Ollama `bge-m3:latest`

`bge-m3` is a broadly used multilingual embedding model with strong Chinese retrieval support. Install it locally before indexing documents:

```sh
ollama pull bge-m3
```

Because AnythingLLM runs in Docker, services on the host machine must be reached through `host.docker.internal`. The Ollama embedding base URL is:

```text
http://host.docker.internal:11434
```

The corresponding AnythingLLM server environment settings are in `anythingllm/server.env`:

```sh
EMBEDDING_ENGINE='ollama'
EMBEDDING_BASE_PATH='http://host.docker.internal:11434'
EMBEDDING_MODEL_PREF='bge-m3:latest'
OLLAMA_EMBEDDING_BATCH_SIZE='1'
```
