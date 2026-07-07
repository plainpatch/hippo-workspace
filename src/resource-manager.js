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
      documents: index.documents,
    };
  }

  async createKnowledgeFolder(relativePath) {
    const safePath = assertSafeRelativePath(relativePath);
    const target = path.join(this.knowledgeDir, safePath);
    await fs.mkdir(target, { recursive: true });
    return { path: safePath, absolutePath: target };
  }

  async ingestKnowledgeText({ relativeDir = "", title, textContent, metadata = {} }) {
    if (!this.client) throw new ResourceManagerError("AnythingLLM client is required for ingestion.", 500);
    await this.ensureBaseDirectories();
    const safeDir = relativeDir ? assertSafeRelativePath(relativeDir) : "";
    const fileName = `${slugify(title || "note")}-${Date.now()}.md`;
    const relativePath = safeDir ? path.posix.join(safeDir, fileName) : fileName;
    const absolutePath = path.join(this.knowledgeDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, String(textContent || ""), "utf8");

    const response = await this.client.uploadRawText({
      textContent,
      metadata: { title, sourcePath: relativePath, ...metadata },
    });
    const documentNames = extractDocumentNames(response);
    await this.recordKnowledgeDocument(relativePath, {
      title: title || fileName,
      type: "text",
      documentNames,
      anythingllmResponse: response,
    });
    return { relativePath, absolutePath, documentNames, response };
  }

  async ingestKnowledgeFile({ relativeDir = "", fileBuffer, fileName, metadata = {} }) {
    if (!this.client) throw new ResourceManagerError("AnythingLLM client is required for ingestion.", 500);
    await this.ensureBaseDirectories();
    const safeDir = relativeDir ? assertSafeRelativePath(relativeDir) : "";
    const safeName = path.basename(fileName || `file-${Date.now()}`);
    const relativePath = safeDir ? path.posix.join(safeDir, safeName) : safeName;
    const absolutePath = path.join(this.knowledgeDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, fileBuffer);

    const response = await this.client.uploadFile({
      fileBuffer,
      fileName: safeName,
      metadata: { sourcePath: relativePath, ...metadata },
    });
    const documentNames = extractDocumentNames(response);
    await this.recordKnowledgeDocument(relativePath, {
      title: safeName,
      type: "file",
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
      documentNames: value.documentNames || [],
      updatedAt: new Date().toISOString(),
    };
    await this.writeKnowledgeIndex(index);
    return index.documents[relativePath];
  }

  async resolveKnowledgeRefs(refs = []) {
    const index = await this.readKnowledgeIndex();
    const selected = new Set((refs || []).filter(Boolean));
    const documentNames = [];
    for (const [relativePath, item] of Object.entries(index.documents)) {
      if (isSelectedKnowledgePath(relativePath, selected)) {
        documentNames.push(...(item.documentNames || []));
      }
    }
    return dedupe(documentNames);
  }

  async readKnowledgeIndex() {
    await this.ensureBaseDirectories();
    try {
      const content = await fs.readFile(this.indexPath, "utf8");
      const index = JSON.parse(content);
      return {
        version: 1,
        documents: index.documents && typeof index.documents === "object" ? index.documents : {},
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, documents: {} };
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
      children.push({
        type: "folder",
        name: entry.name,
        path: relativePath,
        children: await readTree(root, absolutePath, index),
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

function isSelectedKnowledgePath(relativePath, selected) {
  if (!selected.size) return false;
  for (const item of selected) {
    const normalized = assertSafeRelativePath(item);
    if (relativePath === normalized || relativePath.startsWith(`${normalized}/`)) return true;
  }
  return false;
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
