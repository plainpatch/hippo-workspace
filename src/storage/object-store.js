import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class ObjectStore {
  constructor({ rootPath }) {
    if (!rootPath) throw new Error("Object store rootPath is required.");
    this.rootPath = path.resolve(rootPath);
  }

  async put(content, { contentType = "application/octet-stream", extension = "" } = {}) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""));
    const hash = createHash("sha256").update(body).digest("hex");
    const normalizedExtension = normalizeExtension(extension || extensionForContentType(contentType));
    const relativePath = path.posix.join("sha256", hash.slice(0, 2), `${hash}${normalizedExtension}`);
    const absolutePath = path.join(this.rootPath, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await fs.access(absolutePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const temporary = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, body, { flag: "wx" });
      await fs.rename(temporary, absolutePath).catch(async (renameError) => {
        await fs.rm(temporary, { force: true });
        if (renameError.code !== "EEXIST") throw renameError;
      });
    }
    return {
      id: `sha256:${hash}`,
      hash,
      path: relativePath,
      absolutePath,
      contentType,
      size: body.length,
    };
  }

  async putJson(value) {
    return this.put(`${JSON.stringify(value)}\n`, {
      contentType: "application/json",
      extension: ".json",
    });
  }

  async read(object) {
    return fs.readFile(this.resolve(object));
  }

  async readText(object, encoding = "utf8") {
    return fs.readFile(this.resolve(object), encoding);
  }

  async readJson(object) {
    return JSON.parse(await this.readText(object));
  }

  resolve(object) {
    const relativePath = typeof object === "string" ? object : object?.path;
    if (!relativePath) throw new Error("Object path is required.");
    const absolutePath = path.resolve(this.rootPath, ...String(relativePath).split("/"));
    const relative = path.relative(this.rootPath, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Object path is outside the object store.");
    return absolutePath;
  }
}

function extensionForContentType(contentType) {
  if (contentType === "application/json") return ".json";
  if (contentType === "text/markdown") return ".md";
  if (contentType === "text/plain") return ".txt";
  return ".bin";
}

function normalizeExtension(value) {
  const extension = String(value || "").trim().toLowerCase();
  if (!extension) return ".bin";
  if (!/^\.[a-z0-9._-]{1,16}$/.test(extension)) throw new Error("Invalid object extension.");
  return extension;
}
