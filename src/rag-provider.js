export class AnythingLlmRagProvider {
  constructor({ client }) {
    this.id = "anythingllm";
    this.client = client;
  }

  async status() {
    return this.client.status();
  }

  async ingestText({ textContent, metadata, addToWorkspaces }) {
    return this.client.uploadRawText({ textContent, metadata, addToWorkspaces });
  }

  async ingestFile({ fileBuffer, fileName, metadata, addToWorkspaces }) {
    return this.client.uploadFile({ fileBuffer, fileName, metadata, addToWorkspaces });
  }

  async retrieve({ workspaceSlug, query, topN = 4, scoreThreshold }) {
    if (!workspaceSlug) return { skipped: true, reason: "missing-workspace-slug", results: [] };
    return this.client.vectorSearch(workspaceSlug, { query, topN, scoreThreshold });
  }

  async chat({ workspaceSlug, message, mode = "query", sessionId, reset }) {
    return this.client.workspaceChat(workspaceSlug, { message, mode, sessionId, reset });
  }

  async ensureWorkspace({ name, description, metadata }) {
    return this.client.createWorkspace({
      name,
      openAiPrompt: description,
      chatMode: "chat",
      metadata,
    });
  }

  async updateWorkspaceEmbeddings(workspaceSlug, payload) {
    return this.client.updateWorkspaceEmbeddings(workspaceSlug, payload);
  }
}

export function createRagProvider({ id = "anythingllm", client }) {
  if (id === "anythingllm") return new AnythingLlmRagProvider({ client });
  throw new RagProviderError(`Unsupported RAG provider: ${id}`, 500);
}

export class RagProviderError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.name = "RagProviderError";
    this.status = status;
    this.details = details;
  }
}
