import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_LIMIT = 20000;
const MAX_READ_LIMIT = 100000;

export class ContextStore {
  constructor({ repository } = {}) {
    if (!repository) throw new Error("ContextStore requires a metadata repository.");
    this.repository = repository;
    this.objectStore = repository.objectStore;
    this.locks = new Map();
  }

  async write({ workspacePath, sessionId, contextId, ref, title, summary = "", content, contentType = "text/markdown", tags = [], source = {}, expectedVersion } = {}) {
    const scope = this.resolveScope(workspacePath, sessionId);
    const parsedRef = ref ? parseContextRef(ref) : undefined;
    if (parsedRef && parsedRef.sessionId !== scope.sessionId) {
      throw new ContextStoreError("Context reference belongs to another session.", 403);
    }
    const itemId = assertIdentifier(parsedRef?.contextId || contextId || randomUUID(), "contextId");
    const body = String(content ?? "");
    if (!body) throw new ContextStoreError("Context content is required.", 400);
    if (Buffer.byteLength(body, "utf8") > MAX_CONTENT_BYTES) {
      throw new ContextStoreError("Context content exceeds the 10 MB limit.", 413);
    }
    return this.withLock(`${scope.workspace.id}:${scope.sessionId}:${itemId}`, async () => {
      const current = this.repository.getContextItem(scope.workspace.id, scope.sessionId, itemId);
      try {
        const item = await this.repository.writeContextItem({
          workspaceId: scope.workspace.id,
          sessionId: scope.sessionId,
          contextId: itemId,
          title: String(title || current?.title || itemId).trim(),
          summary: String(summary || current?.summary || "").trim(),
          content: body,
          contentType,
          tags: dedupe(tags.length ? tags : current?.tags || []),
          source: normalizeSource(source),
          expectedVersion,
        });
        return buildWriteResult(scope.sessionId, item, item.versions.at(-1), this.objectStore);
      } catch (error) {
        if (error.code === "CONTEXT_VERSION_CONFLICT") {
          throw new ContextStoreError("Context version conflict.", 409, {
            expectedVersion,
            actualVersion: error.actualVersion,
          });
        }
        throw error;
      }
    });
  }

  async read({ workspacePath, sessionId, ref, offset = 0, limit = DEFAULT_READ_LIMIT, headings = [] } = {}) {
    const scope = this.resolveScope(workspacePath, sessionId);
    const target = this.resolveVersion(scope, ref);
    const body = await this.objectStore.readText(target.version.path);
    const selected = selectMarkdownHeadings(body, headings);
    const start = Math.max(0, Number(offset) || 0);
    const readLimit = Math.min(MAX_READ_LIMIT, Math.max(1, Number(limit) || DEFAULT_READ_LIMIT));
    const content = selected.slice(start, start + readLimit);
    return {
      ref: formatContextRef(scope.sessionId, target.item.id, target.version.version),
      title: target.item.title,
      summary: target.item.summary,
      tags: target.item.tags,
      contentType: target.version.contentType,
      content,
      offset: start,
      nextOffset: start + content.length < selected.length ? start + content.length : null,
      totalCharacters: selected.length,
      truncated: start + content.length < selected.length,
      path: this.objectStore.resolve(target.version.path),
      contentHash: target.version.contentHash,
      source: target.version.source,
    };
  }

  async list({ workspacePath, sessionId, tags = [], sourceRunId = "", sourceNodeId = "", refs, page = 1, pageSize = 50 } = {}) {
    const scope = this.resolveScope(workspacePath, sessionId);
    const requiredTags = dedupe(tags);
    const allowedIds = contextIdsFromRefs(refs, scope.sessionId);
    const items = this.repository.listContextItems(scope.workspace.id, scope.sessionId)
      .filter((item) => !allowedIds || allowedIds.has(item.id))
      .filter((item) => requiredTags.every((tag) => item.tags.includes(tag)))
      .filter((item) => {
        const source = item.versions.at(-1)?.source || {};
        return (!sourceRunId || source.runId === sourceRunId) && (!sourceNodeId || source.nodeId === sourceNodeId);
      });
    const size = Math.min(100, Math.max(1, Number(pageSize) || 50));
    const currentPage = Math.max(1, Number(page) || 1);
    const start = (currentPage - 1) * size;
    return {
      sessionId: scope.sessionId,
      page: currentPage,
      pageSize: size,
      total: items.length,
      items: items.slice(start, start + size).map((item) => summarizeItem(scope.sessionId, item)),
    };
  }

  async search({ workspacePath, sessionId, query, tags = [], refs, page = 1, pageSize = 20 } = {}) {
    const scope = this.resolveScope(workspacePath, sessionId);
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) throw new ContextStoreError("Context search query is required.", 400);
    const requiredTags = dedupe(tags);
    const allowedIds = contextIdsFromRefs(refs, scope.sessionId);
    const matches = [];
    for (const item of this.repository.listContextItems(scope.workspace.id, scope.sessionId)) {
      if (allowedIds && !allowedIds.has(item.id)) continue;
      if (!requiredTags.every((tag) => item.tags.includes(tag))) continue;
      const latest = item.versions.at(-1);
      const body = await this.objectStore.readText(latest.path);
      const haystack = `${item.title}\n${item.summary}\n${item.tags.join(" ")}\n${body}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      const bodyIndex = body.toLowerCase().indexOf(needle);
      matches.push({
        ...summarizeItem(scope.sessionId, item),
        excerpt: bodyIndex === -1 ? item.summary : excerptAround(body, bodyIndex, needle.length),
      });
    }
    const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const currentPage = Math.max(1, Number(page) || 1);
    const start = (currentPage - 1) * size;
    return { sessionId: scope.sessionId, query, page: currentPage, pageSize: size, total: matches.length, items: matches.slice(start, start + size) };
  }

  async assertReadable({ workspacePath, sessionId, ref, allowedRefs } = {}) {
    const scope = this.resolveScope(workspacePath, sessionId);
    const parsed = parseContextRef(ref);
    if (parsed.sessionId !== scope.sessionId) throw new ContextStoreError("Context reference belongs to another session.", 403);
    if (allowedRefs && !isAllowedRef(parsed, allowedRefs)) throw new ContextStoreError("Context reference was not granted to this node.", 403);
    if (!this.repository.getContextItem(scope.workspace.id, scope.sessionId, parsed.contextId)) {
      throw new ContextStoreError("Context item was not found.", 404);
    }
    return true;
  }

  async deleteSession({ workspacePath, sessionId } = {}) {
    const scope = this.resolveScope(workspacePath, sessionId);
    this.repository.deleteContextSession(scope.workspace.id, scope.sessionId);
    return { deleted: true, sessionId: scope.sessionId };
  }

  resolveScope(workspacePath, sessionId) {
    if (!workspacePath) throw new ContextStoreError("Workspace path is required.", 400);
    const normalizedPath = path.resolve(String(workspacePath));
    const workspace = this.repository.getWorkspaceByPath(normalizedPath);
    if (!workspace) throw new ContextStoreError("Workspace was not found for the context path.", 404);
    return { workspace, sessionId: assertIdentifier(sessionId, "sessionId") };
  }

  resolveVersion(scope, ref) {
    const parsed = parseContextRef(ref);
    if (parsed.sessionId !== scope.sessionId) throw new ContextStoreError("Context reference belongs to another session.", 403);
    const item = this.repository.getContextItem(scope.workspace.id, scope.sessionId, parsed.contextId);
    if (!item) throw new ContextStoreError("Context item was not found.", 404);
    const versionNumber = parsed.version || item.latestVersion;
    const version = item.versions.find((entry) => entry.version === versionNumber);
    if (!version) throw new ContextStoreError("Context version was not found.", 404);
    return { item, version };
  }

  async withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

export class ContextStoreError extends Error {
  constructor(message, status = 500, details) {
    super(message);
    this.name = "ContextStoreError";
    this.status = status;
    this.details = details;
  }
}

export function formatContextRef(sessionId, contextId, version) {
  return `ctx://${assertIdentifier(sessionId, "sessionId")}/${assertIdentifier(contextId, "contextId")}@${Number(version)}`;
}

export function parseContextRef(ref) {
  const match = String(ref || "").match(/^ctx:\/\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:@(\d+))?$/);
  if (!match) throw new ContextStoreError("Invalid context reference.", 400);
  return { sessionId: match[1], contextId: match[2], version: match[3] ? Number(match[3]) : undefined };
}

function assertIdentifier(value, field) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(normalized) || normalized === "." || normalized === "..") {
    throw new ContextStoreError(`Invalid ${field}.`, 400);
  }
  return normalized;
}

function normalizeSource(source) {
  return Object.fromEntries(Object.entries({
    role: source.role ? String(source.role) : "",
    runId: source.runId ? String(source.runId) : "",
    nodeId: source.nodeId ? String(source.nodeId) : "",
    agentId: source.agentId ? String(source.agentId) : "",
  }).filter(([, value]) => value));
}

function buildWriteResult(sessionId, item, version, objectStore) {
  return {
    ref: formatContextRef(sessionId, item.id, version.version),
    id: item.id,
    version: version.version,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    contentType: version.contentType,
    contentHash: version.contentHash,
    size: version.size,
    path: objectStore.resolve(version.path),
    source: version.source,
  };
}

function summarizeItem(sessionId, item) {
  const latest = item.versions.at(-1);
  return {
    ref: formatContextRef(sessionId, item.id, latest.version),
    id: item.id,
    version: latest.version,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    contentType: latest.contentType,
    size: latest.size,
    source: latest.source,
    updatedAt: item.updatedAt,
  };
}

function selectMarkdownHeadings(content, headings) {
  const requested = dedupe(headings);
  if (!requested.length) return content;
  const lines = content.split("\n");
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!match || !requested.includes(match[2].trim())) continue;
    const level = match[1].length;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end].match(/^(#{1,6})\s+/);
      if (next && next[1].length <= level) break;
      end += 1;
    }
    sections.push(lines.slice(index, end).join("\n"));
  }
  return sections.join("\n\n");
}

function isAllowedRef(parsed, allowedRefs) {
  return allowedRefs.some((ref) => {
    const allowed = parseContextRef(typeof ref === "string" ? ref : ref.ref);
    return allowed.sessionId === parsed.sessionId
      && allowed.contextId === parsed.contextId
      && (!parsed.version || !allowed.version || allowed.version === parsed.version);
  });
}

function contextIdsFromRefs(refs, sessionId) {
  if (!Array.isArray(refs)) return undefined;
  return new Set(refs.map((ref) => {
    const parsed = parseContextRef(typeof ref === "string" ? ref : ref.ref);
    if (parsed.sessionId !== sessionId) throw new ContextStoreError("Context reference belongs to another session.", 403);
    return parsed.contextId;
  }));
}

function excerptAround(content, index, length) {
  const start = Math.max(0, index - 120);
  const end = Math.min(content.length, index + length + 180);
  return `${start ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function dedupe(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean))];
}
