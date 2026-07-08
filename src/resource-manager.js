import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const KNOWLEDGE_INDEX_FILE = ".hippo-knowledge-index.json";

export class ResourceManager {
  constructor({ rootPath = config.resourceRootPath, client }) {
    this.rootPath = rootPath;
    this.client = client;
    this.projectsDir = path.join(rootPath, "projects");
    this.knowledgeDir = path.join(rootPath, "knowledge");
    this.indexPath = path.join(rootPath, KNOWLEDGE_INDEX_FILE);
  }

  async ensureBaseDirectories() {
    await fs.mkdir(this.projectsDir, { recursive: true });
    await fs.mkdir(this.knowledgeDir, { recursive: true });
  }

  async getStatus() {
    await this.ensureBaseDirectories();
    return {
      rootPath: this.rootPath,
      projectsDir: this.projectsDir,
      knowledgeDir: this.knowledgeDir,
      indexPath: this.indexPath,
    };
  }

  async createProjectWorkspace({ projectId, projectName }) {
    await this.ensureBaseDirectories();
    const folderName = `${slugify(projectName)}-${projectId.slice(0, 8)}`;
    const workspacePath = path.join(this.projectsDir, folderName);
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "workspace.json"),
      `${JSON.stringify({ projectId, projectName, createdAt: new Date().toISOString() }, null, 2)}\n`,
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
    return this.createKnowledgeFolder(topicPath, {
      name: displayName,
      description: topicDescription,
      metadata,
    });
  }

  async updateKnowledgeDrawer({ drawerPath, name, description, metadata = {} } = {}) {
    const safePath = assertDrawerPath(drawerPath);
    if (!safePath) throw new ResourceManagerError("Knowledge drawer path is required.", 400);
    await this.ensureDrawerExists(safePath);
    return this.upsertDrawerMetadata(safePath, {
      name: name ? String(name).trim() : undefined,
      description: description !== undefined ? String(description).trim() : undefined,
      metadata,
    });
  }

  async ingestKnowledgeText({ relativeDir = "", title, textContent, metadata = {} }) {
    if (!this.client) throw new ResourceManagerError("AnythingLLM client is required for ingestion.", 500);
    await this.ensureBaseDirectories();
    const safeDir = relativeDir ? assertDrawerPath(relativeDir) : "";
    const fileName = `${slugify(title || "note")}-${Date.now()}.md`;
    const relativePath = safeDir ? path.posix.join(safeDir, fileName) : fileName;
    const absolutePath = path.join(this.knowledgeDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, String(textContent || ""), "utf8");

    const response = this.client.ingestText
      ? await this.client.ingestText({ textContent, metadata: { title, sourcePath: relativePath, ...metadata } })
      : await this.client.uploadRawText({
          textContent,
          metadata: { title, sourcePath: relativePath, ...metadata },
        });
    const documentNames = extractDocumentNames(response);
    await this.ensureDrawerMetadata(safeDir, metadata);
    await this.recordKnowledgeDocument(relativePath, {
      title: title || fileName,
      type: "text",
      drawer: getPrimaryDrawer(relativePath),
      tags: getSecondaryTags(relativePath),
      documentNames,
      anythingllmResponse: response,
    });
    return { relativePath, absolutePath, documentNames, response };
  }

  async ingestKnowledgeFile({ relativeDir = "", fileBuffer, fileName, metadata = {} }) {
    if (!this.client) throw new ResourceManagerError("AnythingLLM client is required for ingestion.", 500);
    await this.ensureBaseDirectories();
    const safeDir = relativeDir ? assertDrawerPath(relativeDir) : "";
    const safeName = path.basename(fileName || `file-${Date.now()}`);
    const relativePath = safeDir ? path.posix.join(safeDir, safeName) : safeName;
    const absolutePath = path.join(this.knowledgeDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, fileBuffer);

    const response = this.client.ingestFile
      ? await this.client.ingestFile({
          fileBuffer,
          fileName: safeName,
          metadata: { sourcePath: relativePath, ...metadata },
        })
      : await this.client.uploadFile({
          fileBuffer,
          fileName: safeName,
          metadata: { sourcePath: relativePath, ...metadata },
        });
    const documentNames = extractDocumentNames(response);
    await this.ensureDrawerMetadata(safeDir, metadata);
    await this.recordKnowledgeDocument(relativePath, {
      title: safeName,
      type: "file",
      drawer: getPrimaryDrawer(relativePath),
      tags: getSecondaryTags(relativePath),
      documentNames,
      anythingllmResponse: response,
    });
    return { relativePath, absolutePath, documentNames, response };
  }

  async recordKnowledgeDocument(relativePath, value) {
    const index = await this.readKnowledgeIndex();
    index.documents[relativePath] = {
      id: index.documents[relativePath]?.id || randomUUID(),
      relativePath,
      title: value.title || path.basename(relativePath),
      type: value.type || "file",
      drawer: value.drawer || getPrimaryDrawer(relativePath),
      tags: value.tags || getSecondaryTags(relativePath),
      documentNames: value.documentNames || [],
      updatedAt: new Date().toISOString(),
    };
    await this.writeKnowledgeIndex(index);
    return index.documents[relativePath];
  }

  async resolveKnowledgeRefs(refs = []) {
    return this.resolveKnowledgeForProject({ drawerRefs: refs });
  }

  async resolveKnowledgeForProject({ drawerRefs = [], tags = [] } = {}) {
    const index = await this.readKnowledgeIndex();
    const selected = new Set((drawerRefs || []).map(assertPrimaryDrawerPath).filter(Boolean));
    const selectedTags = new Set((tags || []).filter(Boolean));
    const documentNames = [];
    for (const [relativePath, item] of Object.entries(index.documents)) {
      if (isSelectedProjectKnowledgePath(relativePath, selected, selectedTags)) {
        documentNames.push(...(item.documentNames || []));
      }
    }
    return dedupe(documentNames);
  }

  async listProjectKnowledge({ drawerRefs = [] } = {}) {
    const index = await this.readKnowledgeIndex();
    const selected = new Set((drawerRefs || []).map(assertPrimaryDrawerPath).filter(Boolean));
    return {
      drawers: buildDrawerList(index).filter((drawer) => selected.has(drawer.path)),
      documents: Object.values(index.documents).filter((item) =>
        isSelectedProjectKnowledgePath(item.relativePath, selected, new Set())
      ),
    };
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
    try {
      const content = await fs.readFile(this.indexPath, "utf8");
      const index = JSON.parse(content);
      return {
        version: 1,
        drawers: index.drawers && typeof index.drawers === "object" ? index.drawers : {},
        documents: index.documents && typeof index.documents === "object" ? index.documents : {},
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, drawers: {}, documents: {} };
      throw error;
    }
  }

  async writeKnowledgeIndex(index) {
    await this.ensureBaseDirectories();
    await fs.writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
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
        children: childTree.children,
      });
    } else if (entry.isFile()) {
      children.push({
        type: "file",
        name: entry.name,
        path: relativePath,
        documentNames: index.documents[relativePath]?.documentNames || [],
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

function requireNonEmpty(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new ResourceManagerError(message, 400);
  return text;
}

function isSelectedProjectKnowledgePath(relativePath, selected, selectedTags) {
  if (!selected.size) return false;
  const drawer = getPrimaryDrawer(relativePath);
  if (!selected.has(drawer)) return false;
  if (!selectedTags.size) return true;
  return getSecondaryTags(relativePath).some((tag) => selectedTags.has(tag));
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
