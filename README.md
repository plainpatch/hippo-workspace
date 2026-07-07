# hippo

This project is configured to run AnythingLLM locally with Docker Compose and includes a wrapper service for RAG administration and MCP access.

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

- creating workspaces
- uploading raw text, URLs, and files
- adding and removing documents from workspace embeddings
- workspace RAG chat
- workspace vector search
- listing documents and workspaces
- custom agent workspaces with system prompts, skills, bound RAG scope, and task execution
- fixed local resource directories for project workspaces and system knowledge references

## Resource directory model

The app uses one fixed resource root:

```text
resources/
  projects/    # one local workspace folder per Hippo project
  knowledge/   # system-level knowledge base tree
```

When a project is created, Hippo creates a folder under `resources/projects/` and creates or binds an AnythingLLM workspace for that project.

The knowledge base is system-level. Use nested folders under `resources/knowledge/` to manage categories, teams, products, or document layers. Projects do not own those files directly. They save references to selected knowledge folders or files through `knowledgeRefs`, and the wrapper resolves those references to AnythingLLM document names before syncing the project's AnythingLLM workspace embeddings.

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

The companion Chrome extension lives in `apps/chrome-extension`. It opens as a Chrome side panel, loads Hippo projects, provides a project-scoped chat surface, and clips the current page or selected text into the Hippo system knowledge base.

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

- select and load a Hippo project
- chat with the selected project's agent
- pass the current page title and URL as runtime context during chat
- read the current page title, URL, selected text, and page text summary
- save content into `resources/knowledge/<目录>`
- optionally associate the knowledge directory with a Hippo project
- open the local Hippo workbench

Context menu:

- select text on a page
- right click
- choose "保存选中文本到 Hippo 知识库"

The context menu uses the default knowledge directory and default project selected in the side panel.

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

- `anythingllm_status`
- `anythingllm_list_workspaces`
- `anythingllm_create_workspace`
- `anythingllm_list_documents`
- `anythingllm_upload_text_document`
- `anythingllm_upload_url`
- `anythingllm_upload_file`
- `anythingllm_update_workspace_embeddings`
- `anythingllm_workspace_chat`
- `anythingllm_vector_search`
- `anythingllm_remove_documents`
- `agent_list_workspaces`
- `agent_create_workspace`
- `agent_get_workspace`
- `agent_update_rag_scope`
- `agent_execute_task`

## Agent orchestration layer

The wrapper also provides a higher-level custom agent workspace abstraction. An agent workspace binds local orchestration metadata to an AnythingLLM workspace:

- local agent workspace id, name, and description
- local workspace folder under `resources/projects/`
- bound AnythingLLM `workspaceSlug`
- predefined system prompt
- allowed skills list
- selected system knowledge references
- resolved RAG document scope
- default execution mode: `query`, `chat`, or `automatic`

Create an agent workspace:

```sh
curl -X POST http://localhost:8787/api/agent-workspaces \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "docs-agent",
    "systemPrompt": "Only answer from the configured knowledge base. Say when evidence is missing.",
    "skills": [
      {
        "name": "summarize",
        "description": "Summarize retrieved technical material into concise action items."
      }
    ],
    "anythingllmWorkspaceSlug": "existing-anythingllm-workspace",
    "knowledgeRefs": ["platform/anythingllm"],
    "ragDocumentNames": ["custom-documents/example.json"],
    "defaultMode": "query",
    "topN": 4
  }'
```

If `anythingllmWorkspaceSlug` is omitted, the wrapper creates a matching AnythingLLM workspace first.

Create a system knowledge folder:

```sh
curl -X POST http://localhost:8787/api/knowledge/folders \
  -H 'Content-Type: application/json' \
  -d '{ "path": "platform/anythingllm" }'
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

Execute a task through an agent workspace:

```sh
curl -X POST http://localhost:8787/api/agent-workspaces/<agent-workspace-id>/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "根据知识库说明这个模块的接入步骤。",
    "mode": "query"
  }'
```

Update the RAG scope:

```sh
curl -X POST http://localhost:8787/api/agent-workspaces/<agent-workspace-id>/rag-scope \
  -H 'Content-Type: application/json' \
  -d '{
    "adds": ["custom-documents/new-doc.json"],
    "deletes": []
  }'
```

Agent workspace definitions are persisted at `data/agent-workspaces.json` on the host through the wrapper container volume.

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
