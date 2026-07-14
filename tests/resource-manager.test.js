import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ResourceManager, ResourceManagerError } from "../src/resource-manager.js";

test("knowledge paths resolve inside the knowledge root and reject traversal", async (t) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-resource-test-"));
  const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-resource-outside-"));
  t.after(async () => {
    await Promise.all([
      fs.rm(rootPath, { recursive: true, force: true }),
      fs.rm(outsidePath, { recursive: true, force: true }),
    ]);
  });

  const manager = new ResourceManager({ rootPath });
  await manager.ensureBaseDirectories();
  const topicPath = path.join(manager.knowledgeDir, "product", "api");
  const documentPath = path.join(topicPath, "contract.md");
  await fs.mkdir(topicPath, { recursive: true });
  await fs.writeFile(documentPath, "API contract", "utf8");

  const resolved = await manager.resolveKnowledgePath("product/api/contract.md");
  assert.equal(resolved.absolutePath, await fs.realpath(documentPath));
  assert.equal(resolved.type, "file");

  await assert.rejects(
    manager.resolveKnowledgePath("../outside.txt"),
    (error) => error instanceof ResourceManagerError && error.status === 400
  );

  await fs.symlink(outsidePath, path.join(manager.knowledgeDir, "outside-link"));
  await assert.rejects(
    manager.resolveKnowledgePath("outside-link"),
    (error) => error instanceof ResourceManagerError && error.status === 403
  );
});

test("knowledge file ingestion stores document metadata under a topic", async (t) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-ingest-test-"));
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));

  const manager = new ResourceManager({ rootPath });
  await manager.createKnowledgeDomain({ name: "Product", description: "Product documents" });
  const topic = await manager.createKnowledgeTopic({
    domainPath: "product",
    name: "API",
    description: "API contracts",
  });
  const result = await manager.ingestKnowledgeFile({
    relativeDir: topic.path,
    fileName: "contract.md",
    fileBuffer: Buffer.from("# Contract"),
  });

  assert.equal(result.relativePath, "product/api/contract.md");
  const knowledge = await manager.listKnowledgeTree();
  const document = knowledge.tree.children[0].children[0].children[0];
  assert.equal(document.title, "contract.md");
  assert.equal(document.sourceSize, 10);
  assert.deepEqual(document.documentNames, []);
});

test("workspace document listing filters suffixes and paginates relative paths", async (t) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-document-list-test-"));
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));

  const manager = new ResourceManager({ rootPath });
  await manager.createKnowledgeDomain({ name: "Product", description: "Product documents" });
  const topic = await manager.createKnowledgeTopic({
    domainPath: "product",
    name: "API",
    description: "API contracts",
  });
  await manager.ingestKnowledgeFile({
    relativeDir: topic.path,
    fileName: "contract.md",
    fileBuffer: Buffer.from("contract"),
  });
  await manager.ingestKnowledgeFile({
    relativeDir: topic.path,
    fileName: "schema.json",
    fileBuffer: Buffer.from("{}"),
  });

  const result = await manager.listWorkspaceKnowledgeDocuments(
    { domainRefs: ["product"], topicRefs: ["product/api"] },
    { suffixes: ["MD"], page: 1, pageSize: 1 }
  );
  assert.equal(result.rootPath, path.join(rootPath, "knowledge"));
  assert.deepEqual(result.filters.suffixes, [".md"]);
  assert.deepEqual(result.pagination, { page: 1, pageSize: 1, total: 1, totalPages: 1 });
  assert.equal(result.documents[0].relativePath, "product/api/contract.md");
  assert.equal(result.documents[0].topicPath, "product/api");
  assert.equal(result.documents[0].suffix, ".md");
  assert.equal("absolutePath" in result.documents[0], false);
});
