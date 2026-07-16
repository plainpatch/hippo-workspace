import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { SqliteStateStore } from "./storage/sqlite-state-store.js";

export class ResourceManager {
  constructor({ rootPath = config.resourceRootPath, client, metadataRepository, stateStore }) {
    this.rootPath = rootPath;
    this.client = client;
    this.workspacesDir = path.join(rootPath, "workspaces");
    this.knowledgeDir = path.join(rootPath, "knowledge");
    this.stateStore = stateStore || (!metadataRepository ? new SqliteStateStore({
      databasePath: path.join(rootPath, "metadata", "hippo.sqlite3"),
      resourceRootPath: rootPath,
    }) : null);
    this.metadataRepository = metadataRepository || this.stateStore.repository;
  }

  async ensureBaseDirectories() {
    await fs.mkdir(this.workspacesDir, { recursive: true });
    await fs.mkdir(this.knowledgeDir, { recursive: true });
  }

  async getStatus() {
    await this.ensureBaseDirectories();
    return {
      rootPath: this.rootPath,
      workspacesDir: this.workspacesDir,
      knowledgeDir: this.knowledgeDir,
      metadataDbPath: this.metadataRepository.database.databasePath,
    };
  }

  async createWorkspace({ workspaceId, workspaceName }) {
    await this.ensureBaseDirectories();
    const folderName = `${slugify(workspaceName)}-${workspaceId.slice(0, 8)}`;
    const workspacePath = path.join(this.workspacesDir, folderName);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "workspace.json"),
      `${JSON.stringify({ workspaceId, workspaceName, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx" }
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    return { workspacePath, workspaceFolderName: folderName };
  }

  async listKnowledgeTree() {
    await this.ensureBaseDirectories();
    const index = await this.readKnowledgeIndex();
    const tree = await readTree(this.knowledgeDir, this.knowledgeDir, index);
    return {
      rootPath: this.knowledgeDir,
      tree,
      drawers: buildDrawerList(index),
      documents: index.documents,
    };
  }

  async resolveKnowledgePath(relativePath) {
    await this.ensureBaseDirectories();
    const safePath = assertSafeRelativePath(relativePath);
    if (!safePath) throw new ResourceManagerError("Knowledge path is required.", 400);

    const targetPath = path.resolve(this.knowledgeDir, safePath);
    const relativeTarget = path.relative(this.knowledgeDir, targetPath);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new ResourceManagerError("Knowledge path is outside the knowledge directory.", 403);
    }

    let realKnowledgeDir;
    let realTargetPath;
    let targetStat;
    try {
      [realKnowledgeDir, realTargetPath] = await Promise.all([
        fs.realpath(this.knowledgeDir),
        fs.realpath(targetPath),
      ]);
      const realRelativeTarget = path.relative(realKnowledgeDir, realTargetPath);
      if (realRelativeTarget.startsWith("..") || path.isAbsolute(realRelativeTarget)) {
        throw new ResourceManagerError("Knowledge path is outside the knowledge directory.", 403);
      }
      targetStat = await fs.stat(realTargetPath);
    } catch (error) {
      if (error instanceof ResourceManagerError) throw error;
      if (error.code === "ENOENT") throw new ResourceManagerError("Knowledge path was not found.", 404);
      throw error;
    }

    return {
      relativePath: safePath,
      absolutePath: realTargetPath,
      type: targetStat.isDirectory() ? "directory" : "file",
    };
  }

  async createKnowledgeFolder(relativePath, metadata = {}) {
    const safePath = assertDrawerPath(relativePath);
    const target = path.join(this.knowledgeDir, safePath);
    await fs.mkdir(target, { recursive: true });
    const drawer = await this.upsertDrawerMetadata(safePath, metadata);
    return { path: safePath, absolutePath: target, drawer };
  }

  async createKnowledgeDomain({ name, description, metadata = {} } = {}) {
    const displayName = requireNonEmpty(name, "Knowledge domain name is required.");
    const drawerDescription = requireNonEmpty(description, "Knowledge domain description is required.");
    const safePath = slugify(displayName);
    return this.createKnowledgeFolder(safePath, {
      name: displayName,
      description: drawerDescription,
      metadata,
    });
  }

  async createKnowledgeTopic({ domainPath, name, description, metadata = {} } = {}) {
    const primaryPath = assertPrimaryDrawerPath(domainPath);
    if (!primaryPath) throw new ResourceManagerError("Knowledge domain is required.", 400);
    const displayName = requireNonEmpty(name, "Knowledge topic name is required.");
    const topicDescription = requireNonEmpty(description, "Knowledge topic description is required.");
    await this.ensureDrawerExists(primaryPath);
    const topicPath = path.posix.join(primaryPath, slugify(displayName));
    const result = await this.createKnowledgeFolder(topicPath, {
      name: displayName,
      description: topicDescription,
      metadata,
    });
    const drawer = await this.ensureTopicRagWorkspace(topicPath);
    return { ...result, drawer };
  }

  async updateKnowledgeNode({ nodePath, name, description, metadata = {} } = {}) {
    const safePath = assertDrawerPath(nodePath);
    if (!safePath) throw new ResourceManagerError("Knowledge drawer path is required.", 400);
    await this.ensureDrawerExists(safePath);
    const drawer = await this.upsertDrawerMetadata(safePath, {
      name: name ? String(name).trim() : undefined,
      description: description !== undefined ? String(description).trim() : undefined,
      metadata,
    });
    if (drawer.level === 2) return this.ensureTopicRagWorkspace(safePath);
    return drawer;
  }

  async ensureTopicRagWorkspace(topicPath) {
    const safePath = assertTopicPath(topicPath);
    const index = await this.readKnowledgeIndex();
    const drawer = index.drawers[safePath];
    if (!drawer) throw new ResourceManagerError(`Knowledge topic ${safePath} was not found.`, 404);
    if (drawer.rag?.workspaceSlug) return drawer;
    if (!this.client?.ensureWorkspace) {
      return this.upsertDrawerMetadata(safePath, {
        metadata: drawer.metadata || {},
        rag: {
          providerId: "unconfigured",
          workspaceSlug: "",
          status: "pending",
          updatedAt: new Date().toISOString(),
        },
      });
    }

    const domain = index.drawers[getPrimaryDrawer(safePath)] || {};
    try {
      const response = await this.client.ensureWorkspace({
        name: `${domain.name || getPrimaryDrawer(safePath)} / ${drawer.name || path.posix.basename(safePath)}`,
        description: [
          domain.description ? `领域：${domain.description}` : "",
          drawer.description ? `主题：${drawer.description}` : "",
          `Hippo topic path: ${safePath}`,
        ].filter(Boolean).join("\n"),
        metadata: { hippoTopicPath: safePath },
      });
      const workspaceSlug = extractWorkspaceSlug(response);
      if (!workspaceSlug) {
        throw new ResourceManagerError("RAG provider created a workspace without a slug.", 502, response);
      }
      return this.upsertDrawerMetadata(safePath, {
        metadata: drawer.metadata || {},
        rag: {
          providerId: "anythingllm",
          workspaceSlug,
          status: "ready",
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return this.upsertDrawerMetadata(safePath, {
        metadata: drawer.metadata || {},
        rag: {
          providerId: "anythingllm",
          workspaceSlug: "",
          status: "error",
          error: error.message || "RAG workspace creation failed.",
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  async ingestKnowledgeText({ relativeDir = "", title, textContent, metadata = {} }) {
    await this.ensureBaseDirectories();
    const safeDir = relativeDir ? assertDrawerPath(relativeDir) : "";
    const fileName = `${slugify(title || "note")}-${Date.now()}.md`;
    const relativePath = safeDir ? path.posix.join(safeDir, fileName) : fileName;
    const absolutePath = path.join(this.knowledgeDir, relativePath);
    const content = String(textContent || "");
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    const topicWorkspace = await this.getTopicWorkspaceForDir(safeDir);
    const { response, ragError } = await this.tryIngestTextToRag({
      textContent: content,
      metadata: { title, sourcePath: relativePath, ...metadata },
      addToWorkspaces: topicWorkspace ? [topicWorkspace] : undefined,
    });
    const documentNames = extractDocumentNames(response);
    await this.ensureDrawerMetadata(safeDir, metadata);
    await this.recordKnowledgeDocument(relativePath, {
      title: title || fileName,
      type: "text",
      drawer: getPrimaryDrawer(relativePath),
      tags: getSecondaryTags(relativePath),
      documentNames,
      topicPath: getTopicPath(relativePath),
      ragWorkspaceSlug: topicWorkspace,
      sourceHash: createHash("sha256").update(content).digest("hex"),
      sourceSize: Buffer.byteLength(content),
      anythingllmResponse: response,
    });
    return { relativePath, absolutePath, documentNames, response, ragError };
  }

  async ingestKnowledgeFile({ relativeDir = "", fileBuffer, fileName, metadata = {} }) {
    await this.ensureBaseDirectories();
    const safeDir = relativeDir ? assertDrawerPath(relativeDir) : "";
    const safeName = path.basename(fileName || `file-${Date.now()}`);
    const relativePath = safeDir ? path.posix.join(safeDir, safeName) : safeName;
    const absolutePath = path.join(this.knowledgeDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, fileBuffer);

    const topicWorkspace = await this.getTopicWorkspaceForDir(safeDir);
    const { response, ragError } = await this.tryIngestFileToRag({
      fileBuffer,
      fileName: safeName,
      metadata: { sourcePath: relativePath, ...metadata },
      addToWorkspaces: topicWorkspace ? [topicWorkspace] : undefined,
    });
    const documentNames = extractDocumentNames(response);
    const stat = await fs.stat(absolutePath);
    await this.ensureDrawerMetadata(safeDir, metadata);
    await this.recordKnowledgeDocument(relativePath, {
      title: safeName,
      type: "file",
      drawer: getPrimaryDrawer(relativePath),
      tags: getSecondaryTags(relativePath),
      documentNames,
      topicPath: getTopicPath(relativePath),
      ragWorkspaceSlug: topicWorkspace,
      sourceHash: createHash("sha256").update(fileBuffer).digest("hex"),
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      anythingllmResponse: response,
    });
    return { relativePath, absolutePath, documentNames, response, ragError };
  }

  async tryIngestTextToRag(payload) {
    if (!this.client) return { response: {}, ragError: { message: "RAG provider is not configured." } };
    try {
      const response = this.client.ingestText
        ? await this.client.ingestText(payload)
        : await this.client.uploadRawText(payload);
      return { response };
    } catch (error) {
      return { response: {}, ragError: serializeRagError(error) };
    }
  }

  async tryIngestFileToRag(payload) {
    if (!this.client) return { response: {}, ragError: { message: "RAG provider is not configured." } };
    try {
      const response = this.client.ingestFile
        ? await this.client.ingestFile(payload)
        : await this.client.uploadFile(payload);
      return { response };
    } catch (error) {
      return { response: {}, ragError: serializeRagError(error) };
    }
  }

  async recordKnowledgeDocument(relativePath, value) {
    const index = await this.readKnowledgeIndex();
    index.documents[relativePath] = buildKnowledgeDocumentRecord(relativePath, {
      id: index.documents[relativePath]?.id,
      relativePath,
      title: value.title || path.basename(relativePath),
      type: value.type || "file",
      drawer: value.drawer || getPrimaryDrawer(relativePath),
      tags: value.tags || getSecondaryTags(relativePath),
      topicPath: value.topicPath || getTopicPath(relativePath),
      ragWorkspaceSlug: value.ragWorkspaceSlug || "",
      documentNames: value.documentNames || [],
      sourceHash: value.sourceHash,
      sourceSize: value.sourceSize,
      sourceMtimeMs: value.sourceMtimeMs,
    });
    await this.writeKnowledgeIndex(index);
    return index.documents[relativePath];
  }

  async getWorkspaceKnowledgeIndex({ domainRefs = [], topicRefs = [] } = {}) {
    const index = await this.readKnowledgeIndex();
    const selectedDomains = new Set((domainRefs || []).map(assertPrimaryDrawerPath).filter(Boolean));
    const selectedTopics = new Set((topicRefs || []).map(assertTopicPath).filter(Boolean));
    const drawers = buildDrawerList(index);
    const domains = drawers
      .filter((drawer) => drawer.level === 1 && selectedDomains.has(drawer.path))
      .map((domain) => ({
        path: domain.path,
        name: domain.name || domain.path,
        description: domain.description || "",
        topics: drawers
          .filter((topic) => isTopicInWorkspaceScope(topic.path, selectedDomains, selectedTopics))
          .filter((topic) => getPrimaryDrawer(topic.path) === domain.path)
          .map((topic) => enrichTopicIndex(topic, index.documents)),
      }));
    const topics = domains.flatMap((domain) => domain.topics.map((topic) => ({
      ...topic,
      domainPath: domain.path,
      domainName: domain.name,
    })));
    return { domains, topics };
  }

  async listWorkspaceKnowledgeDocuments(
    { domainRefs = [], topicRefs = [] } = {},
    { suffixes = [], page = 1, pageSize = 50 } = {}
  ) {
    await this.ensureBaseDirectories();
    const index = await this.readKnowledgeIndex();
    const selectedDomains = new Set((domainRefs || []).map(assertPrimaryDrawerPath).filter(Boolean));
    const selectedTopics = new Set((topicRefs || []).map(assertTopicPath).filter(Boolean));
    const normalizedSuffixes = normalizeDocumentSuffixes(suffixes);
    const documents = Object.values(index.documents || {})
      .filter((document) => {
        const topic = document.topicPath || getTopicPath(document.relativePath);
        return isTopicInWorkspaceScope(topic, selectedDomains, selectedTopics);
      })
      .filter((document) => {
        if (!normalizedSuffixes.length) return true;
        return normalizedSuffixes.includes(path.posix.extname(document.relativePath).toLowerCase());
      })
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((document) => ({
        id: document.id,
        title: document.title || path.posix.basename(document.relativePath),
        relativePath: document.relativePath,
        domainPath: getPrimaryDrawer(document.relativePath),
        topicPath: document.topicPath || getTopicPath(document.relativePath),
        suffix: path.posix.extname(document.relativePath).toLowerCase(),
        type: document.type,
        sourceSize: document.sourceSize,
        updatedAt: document.updatedAt,
      }));
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
    const offset = (safePage - 1) * safePageSize;
    return {
      rootPath: this.knowledgeDir,
      filters: { suffixes: normalizedSuffixes },
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        total: documents.length,
        totalPages: Math.ceil(documents.length / safePageSize),
      },
      documents: documents.slice(offset, offset + safePageSize),
    };
  }

  async syncTopicWorkspace(topicPath, options = {}) {
    const safePath = assertTopicPath(topicPath);
    const drawer = await this.ensureTopicRagWorkspace(safePath);
    const workspaceSlug = drawer.rag?.workspaceSlug;
    const index = await this.readKnowledgeIndex();
    const scanned = await this.scanTopicDocuments(safePath);
    const synced = [];
    const skipped = [];
    const errors = [];

    if (workspaceSlug && this.client?.ingestFile) {
      for (const file of scanned) {
        const current = index.documents[file.relativePath];
        const unchanged = !options.force
          && current?.sourceHash === file.sourceHash
          && current?.sourceSize === file.sourceSize
          && (current.documentNames || []).length;
        if (unchanged) {
          skipped.push({ relativePath: file.relativePath, reason: "unchanged" });
          continue;
        }

        try {
          const fileBuffer = await fs.readFile(file.absolutePath);
          const response = await this.client.ingestFile({
            fileBuffer,
            fileName: file.fileName,
            metadata: {
              title: current?.title || file.fileName,
              sourcePath: file.relativePath,
              hippoTopicPath: safePath,
            },
            addToWorkspaces: [workspaceSlug],
          });
          const documentNames = extractDocumentNames(response);
          index.documents[file.relativePath] = buildKnowledgeDocumentRecord(file.relativePath, {
            id: current?.id,
            title: current?.title || file.fileName,
            type: "file",
            drawer: getPrimaryDrawer(file.relativePath),
            tags: getSecondaryTags(file.relativePath),
            topicPath: safePath,
            ragWorkspaceSlug: workspaceSlug,
            documentNames,
            sourceHash: file.sourceHash,
            sourceSize: file.sourceSize,
            sourceMtimeMs: file.sourceMtimeMs,
          });
          synced.push({
            relativePath: file.relativePath,
            documentNames,
            previousDocumentNames: current?.documentNames || [],
          });
        } catch (error) {
          errors.push({
            relativePath: file.relativePath,
            error: error.message || "RAG document upload failed.",
          });
        }
      }
      if (synced.length) await this.writeKnowledgeIndex(index);
    } else {
      for (const file of scanned) {
        if (index.documents[file.relativePath]?.documentNames?.length) {
          skipped.push({ relativePath: file.relativePath, reason: "already-indexed" });
          continue;
        }
        index.documents[file.relativePath] = buildKnowledgeDocumentRecord(file.relativePath, {
          id: index.documents[file.relativePath]?.id,
          title: file.fileName,
          type: "file",
          drawer: getPrimaryDrawer(file.relativePath),
          tags: getSecondaryTags(file.relativePath),
          topicPath: safePath,
          ragWorkspaceSlug: workspaceSlug || "",
          documentNames: [],
          sourceHash: file.sourceHash,
          sourceSize: file.sourceSize,
          sourceMtimeMs: file.sourceMtimeMs,
        });
        synced.push({ relativePath: file.relativePath, documentNames: [] });
      }
      if (synced.length) await this.writeKnowledgeIndex(index);
    }

    const nextIndex = synced.length ? await this.readKnowledgeIndex() : index;
    const documentNames = Object.values(nextIndex.documents)
      .filter((item) => item.topicPath === safePath || getTopicPath(item.relativePath) === safePath)
      .flatMap((item) => item.documentNames || []);
    if (workspaceSlug && documentNames.length && this.client?.updateWorkspaceEmbeddings) {
      await this.client.updateWorkspaceEmbeddings(workspaceSlug, {
        adds: dedupe(documentNames),
        deletes: dedupe(synced.flatMap((item) => item.previousDocumentNames || [])),
      });
    }
    const status = workspaceSlug
      ? errors.length ? "partial" : "synced"
      : drawer.rag?.status || "pending";
    await this.upsertDrawerMetadata(safePath, {
      metadata: drawer.metadata || {},
      rag: {
        ...(drawer.rag || {}),
        providerId: drawer.rag?.providerId || (workspaceSlug ? "anythingllm" : "unconfigured"),
        workspaceSlug: workspaceSlug || "",
        status,
        documentCount: Object.values(nextIndex.documents)
          .filter((item) => item.topicPath === safePath || getTopicPath(item.relativePath) === safePath)
          .length,
        syncedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: errors[0]?.error || drawer.rag?.error || "",
      },
    });
    return {
      topicPath: safePath,
      workspaceSlug,
      documentNames: dedupe(documentNames),
      scanned: scanned.length,
      synced,
      skipped,
      errors,
      status,
    };
  }

  async scanTopicDocuments(topicPath) {
    const safePath = assertTopicPath(topicPath);
    const topicDir = path.join(this.knowledgeDir, safePath);
    const files = await listFiles(topicDir).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const result = [];
    for (const absolutePath of files) {
      const stat = await fs.stat(absolutePath);
      const buffer = await fs.readFile(absolutePath);
      const relativePath = toPosix(path.relative(this.knowledgeDir, absolutePath));
      result.push({
        absolutePath,
        relativePath,
        fileName: path.basename(absolutePath),
        sourceHash: createHash("sha256").update(buffer).digest("hex"),
        sourceSize: stat.size,
        sourceMtimeMs: stat.mtimeMs,
      });
    }
    return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async getTopicWorkspaceForDir(relativeDir) {
    const safeDir = relativeDir ? assertDrawerPath(relativeDir) : "";
    if (!safeDir || safeDir.split("/").length !== 2) return "";
    const drawer = await this.ensureTopicRagWorkspace(safeDir);
    return drawer.rag?.workspaceSlug || "";
  }

  async upsertDrawerMetadata(relativePath, metadata = {}) {
    const safePath = assertDrawerPath(relativePath);
    const index = await this.readKnowledgeIndex();
    const now = new Date().toISOString();
    index.drawers[safePath] = {
      path: safePath,
      level: safePath.split("/").length,
      name: metadata.name || index.drawers[safePath]?.name || path.posix.basename(safePath),
      description: metadata.description || index.drawers[safePath]?.description || "",
      enabled: metadata.enabled ?? index.drawers[safePath]?.enabled ?? true,
      metadata: metadata.metadata || index.drawers[safePath]?.metadata || {},
      rag: metadata.rag || index.drawers[safePath]?.rag || undefined,
      updatedAt: now,
      createdAt: index.drawers[safePath]?.createdAt || now,
    };
    await this.writeKnowledgeIndex(index);
    return index.drawers[safePath];
  }

  async ensureDrawerMetadata(relativePath, metadata = {}) {
    const safePath = relativePath ? assertDrawerPath(relativePath) : "";
    if (!safePath) return undefined;
    const parts = safePath.split("/");
    await this.upsertDrawerMetadata(parts[0], metadata.drawer || {});
    if (parts[1]) return this.upsertDrawerMetadata(safePath, metadata.tag || {});
    return undefined;
  }

  async ensureDrawerExists(relativePath) {
    const safePath = assertDrawerPath(relativePath);
    const index = await this.readKnowledgeIndex();
    if (!index.drawers[safePath]) {
      throw new ResourceManagerError(`Knowledge drawer ${safePath} was not found.`, 404);
    }
    return index.drawers[safePath];
  }

  async readKnowledgeIndex() {
    await this.ensureBaseDirectories();
    return this.metadataRepository.readKnowledgeIndex();
  }

  async writeKnowledgeIndex(index) {
    await this.ensureBaseDirectories();
    this.metadataRepository.writeKnowledgeIndex(index);
  }
}

export class ResourceManagerError extends Error {
  constructor(message, status = 500, details = undefined) {
    super(message);
    this.name = "ResourceManagerError";
    this.status = status;
    this.details = details;
  }
}

async function readTree(root, current, index) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const children = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(current, entry.name);
    const relativePath = toPosix(path.relative(root, absolutePath));
    if (entry.isDirectory()) {
      const childTree = await readTree(root, absolutePath, index);
      const drawer = index.drawers[relativePath] || {};
      children.push({
        type: "folder",
        name: entry.name,
        path: relativePath,
        title: drawer.name || entry.name,
        description: drawer.description || "",
        level: relativePath ? relativePath.split("/").length : 0,
        metadata: drawer.metadata || {},
        rag: drawer.rag || {},
        children: childTree.children,
      });
    } else if (entry.isFile()) {
      const document = index.documents[relativePath] || {};
      children.push({
        type: "file",
        name: entry.name,
        path: relativePath,
        title: document.title || entry.name,
        documentNames: document.documentNames || [],
        sourceSize: document.sourceSize,
        sourceMtimeMs: document.sourceMtimeMs,
        updatedAt: document.updatedAt,
      });
    }
  }
  return { type: "folder", name: "knowledge", path: "", children };
}

function assertSafeRelativePath(value) {
  const normalized = toPosix(path.posix.normalize(String(value || "").replaceAll("\\", "/")));
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new ResourceManagerError("Path must be relative to the knowledge directory.", 400);
  }
  return normalized;
}

function assertDrawerPath(value) {
  const normalized = assertSafeRelativePath(value);
  if (!normalized) return "";
  const parts = normalized.split("/");
  if (parts.length > 2) {
    throw new ResourceManagerError("Knowledge paths only support a primary drawer and optional secondary tag.", 400);
  }
  return normalized;
}

function assertPrimaryDrawerPath(value) {
  const normalized = assertSafeRelativePath(value);
  if (!normalized) return "";
  return normalized.split("/")[0];
}

function assertTopicPath(value) {
  const normalized = assertDrawerPath(value);
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ResourceManagerError("Knowledge topic path must include a primary drawer and a secondary topic.", 400);
  }
  return normalized;
}

function requireNonEmpty(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new ResourceManagerError(message, 400);
  return text;
}

function extractDocumentNames(response) {
  const candidates = [
    response?.document?.name,
    response?.document?.location,
    response?.document?.docpath,
    response?.documents?.[0]?.name,
    response?.documents?.[0]?.location,
    response?.documents?.[0]?.docpath,
    response?.name,
    response?.location,
    response?.docpath,
  ].filter(Boolean);

  if (Array.isArray(response?.documents)) {
    for (const item of response.documents) {
      if (item?.name) candidates.push(item.name);
      if (item?.location) candidates.push(item.location);
      if (item?.docpath) candidates.push(item.docpath);
    }
  }
  return dedupe(candidates.map(String));
}

function buildKnowledgeDocumentRecord(relativePath, value = {}) {
  return {
    id: value.id || randomUUID(),
    relativePath,
    title: value.title || path.basename(relativePath),
    type: value.type || "file",
    drawer: value.drawer || getPrimaryDrawer(relativePath),
    tags: value.tags || getSecondaryTags(relativePath),
    topicPath: value.topicPath || getTopicPath(relativePath),
    ragWorkspaceSlug: value.ragWorkspaceSlug || "",
    documentNames: value.documentNames || [],
    sourceHash: value.sourceHash || "",
    sourceSize: Number.isFinite(value.sourceSize) ? value.sourceSize : undefined,
    sourceMtimeMs: Number.isFinite(value.sourceMtimeMs) ? value.sourceMtimeMs : undefined,
    updatedAt: new Date().toISOString(),
  };
}

function serializeRagError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error || "RAG provider request failed."),
    status: error?.status,
    details: error?.details,
  };
}

async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function slugify(value) {
  return String(value || "workspace")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function getPrimaryDrawer(relativePath) {
  return assertSafeRelativePath(relativePath).split("/")[0] || "";
}

function getSecondaryTags(relativePath) {
  const parts = assertSafeRelativePath(relativePath).split("/");
  return parts.length > 2 ? [parts[1]] : parts.length === 2 && !parts[1].includes(".") ? [parts[1]] : [];
}

function getTopicPath(relativePath) {
  const parts = assertSafeRelativePath(relativePath).split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
}

function isTopicInWorkspaceScope(topicPath, selectedDomains, selectedTopics) {
  if (!topicPath || topicPath.split("/").length !== 2) return false;
  if (!selectedDomains.has(getPrimaryDrawer(topicPath))) return false;
  return !selectedTopics.size || selectedTopics.has(topicPath);
}

function normalizeDocumentSuffixes(suffixes = []) {
  return [...new Set((suffixes || []).map((suffix) => {
    const value = String(suffix || "").trim().toLowerCase();
    if (!value) return "";
    return value.startsWith(".") ? value : `.${value}`;
  }).filter(Boolean))];
}

function enrichTopicIndex(topic, documentsByPath) {
  const documents = Object.values(documentsByPath || {}).filter((item) =>
    item.topicPath === topic.path || getTopicPath(item.relativePath) === topic.path
  );
  return {
    path: topic.path,
    name: topic.name || path.posix.basename(topic.path),
    description: topic.description || "",
    rag: topic.rag || {},
    documentCount: documents.length,
    documents: documents.map((document) => ({
      id: document.id,
      relativePath: document.relativePath,
      title: document.title,
      type: document.type,
      documentNames: document.documentNames || [],
      updatedAt: document.updatedAt,
    })),
  };
}

function extractWorkspaceSlug(response) {
  return response?.workspace?.slug || response?.slug || response?.workspace?.[0]?.slug;
}

function buildDrawerList(index) {
  const drawers = { ...(index.drawers || {}) };
  for (const item of Object.values(index.documents || {})) {
    if (item.drawer && !drawers[item.drawer]) {
      drawers[item.drawer] = {
        path: item.drawer,
        level: 1,
        name: item.drawer,
        description: "",
        enabled: true,
      };
    }
    for (const tag of item.tags || []) {
      const tagPath = `${item.drawer}/${tag}`;
      if (!drawers[tagPath]) {
        drawers[tagPath] = {
          path: tagPath,
          level: 2,
          name: tag,
          description: "",
          enabled: true,
        };
      }
    }
  }
  return Object.values(drawers).sort((a, b) => a.path.localeCompare(b.path));
}
