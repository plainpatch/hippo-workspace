import fs from "node:fs/promises";
import path from "node:path";

export class AnythingLlmClient {
  constructor({ baseUrl, apiKey }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async status() {
    const auth = await this.request("/auth");
    return {
      ok: true,
      baseUrl: this.baseUrl,
      auth,
    };
  }

  async listWorkspaces() {
    return this.request("/workspaces");
  }

  async createWorkspace(payload) {
    return this.request("/workspace/new", {
      method: "POST",
      body: payload,
    });
  }

  async listDocuments() {
    return this.request("/documents");
  }

  async getDocument(docName) {
    return this.request(`/document/${encodeURIComponent(docName)}`);
  }

  async uploadRawText({ textContent, addToWorkspaces, metadata }) {
    return this.request("/document/raw-text", {
      method: "POST",
      body: {
        textContent,
        addToWorkspaces: formatWorkspaceList(addToWorkspaces),
        metadata,
      },
    });
  }

  async uploadLink({ link, addToWorkspaces, scraperHeaders, metadata }) {
    return this.request("/document/upload-link", {
      method: "POST",
      body: {
        link,
        addToWorkspaces: formatWorkspaceList(addToWorkspaces),
        scraperHeaders,
        metadata,
      },
    });
  }

  async uploadFile({ filePath, fileBuffer, fileName, addToWorkspaces, metadata }) {
    const form = new FormData();
    const name = fileName || path.basename(filePath);
    const buffer = fileBuffer || (await fs.readFile(filePath));
    form.append("file", new Blob([buffer]), name);

    const workspaceList = formatWorkspaceList(addToWorkspaces);
    if (workspaceList) form.append("addToWorkspaces", workspaceList);
    if (metadata) form.append("metadata", JSON.stringify(metadata));

    return this.request("/document/upload", {
      method: "POST",
      form,
    });
  }

  async updateWorkspaceEmbeddings(slug, { adds = [], deletes = [] }) {
    return this.request(`/workspace/${encodeURIComponent(slug)}/update-embeddings`, {
      method: "POST",
      body: { adds, deletes },
    });
  }

  async workspaceChat(slug, { message, mode = "query", sessionId, attachments, reset }) {
    return this.request(`/workspace/${encodeURIComponent(slug)}/chat`, {
      method: "POST",
      body: prune({
        message,
        mode,
        sessionId,
        attachments,
        reset,
      }),
    });
  }

  async vectorSearch(slug, { query, topN = 4, scoreThreshold }) {
    return this.request(`/workspace/${encodeURIComponent(slug)}/vector-search`, {
      method: "POST",
      body: prune({
        query,
        topN,
        scoreThreshold,
      }),
    });
  }

  async removeDocuments(names) {
    return this.request("/system/remove-documents", {
      method: "DELETE",
      body: { names },
    });
  }

  async request(pathname, { method = "GET", body, form } = {}) {
    if (!this.apiKey) {
      throw new AnythingLlmError(
        "ANYTHINGLLM_API_KEY is not configured for the wrapper service.",
        401
      );
    }

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    let requestBody;
    if (form) {
      requestBody = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(prune(body));
    }

    const response = await fetch(`${this.baseUrl}/api/v1${pathname}`, {
      method,
      headers,
      body: requestBody,
    });

    const text = await response.text();
    const data = parseResponse(text);
    if (!response.ok) {
      throw new AnythingLlmError(
        data?.error || data?.message || `AnythingLLM API returned ${response.status}`,
        response.status,
        data
      );
    }
    return data;
  }
}

export class AnythingLlmError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.name = "AnythingLlmError";
    this.status = status;
    this.details = details;
  }
}

export function formatWorkspaceList(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.filter(Boolean).join(",");
  return String(value);
}

export function parseMetadata(value) {
  if (!value) return undefined;
  if (typeof value === "object") return value;
  return JSON.parse(value);
}

export function prune(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== "")
  );
}

function parseResponse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
