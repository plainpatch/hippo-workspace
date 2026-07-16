import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("workspace attachments preserve folders, serve media, and reject traversal", { timeout: 15000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-attachments-"));
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WRAPPER_PORT: String(port),
      HIPPO_APP_HOME: home,
      HIPPO_DATABASE_PATH: path.join(home, "metadata.sqlite3"),
      RESOURCE_ROOT_PATH: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await fs.rm(home, { recursive: true, force: true });
  });
  await poll(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    return fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.ok).catch(() => false);
  });

  const workspace = await fetch(`http://127.0.0.1:${port}/api/workspaces/default`, { method: "POST" })
    .then((response) => response.json()).then((data) => data.workspace);
  const imageBody = new FormData();
  imageBody.append("kind", "image");
  imageBody.append("relativePaths", JSON.stringify(["截图.png"]));
  imageBody.append("files", new Blob([Buffer.from("89504e47", "hex")], { type: "image/png" }), "截图.png");
  const imageResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/attachments`, {
    method: "POST",
    body: imageBody,
  });
  assert.equal(imageResponse.status, 200);
  const image = (await imageResponse.json()).attachments[0];
  assert.equal(image.kind, "image");
  assert.equal(image.name, "截图.png");
  await fs.access(path.join(workspace.localWorkspacePath, ...image.path.split("/")));
  const served = await fetch(`http://127.0.0.1:${port}/workspace-files/${workspace.id}?path=${encodeURIComponent(image.path)}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type"), /image\/png/);

  const folderBody = new FormData();
  folderBody.append("kind", "folder");
  folderBody.append("relativePaths", JSON.stringify(["docs/readme.md", "docs/src/index.js"]));
  folderBody.append("files", new Blob(["# Readme"], { type: "text/markdown" }), "readme.md");
  folderBody.append("files", new Blob(["export {};"], { type: "text/javascript" }), "index.js");
  const folderResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/attachments`, {
    method: "POST",
    body: folderBody,
  });
  const folder = (await folderResponse.json()).attachments[0];
  assert.equal(folder.kind, "folder");
  assert.equal(folder.childCount, 2);
  const listing = await fetch(`http://127.0.0.1:${port}/workspace-files/${workspace.id}?path=${encodeURIComponent(folder.path)}`);
  assert.equal(listing.status, 200);
  assert.match(await listing.text(), /readme\.md/);
  const artifacts = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/artifacts`)
    .then((response) => response.json()).then((data) => data.artifacts);
  assert.equal(artifacts.length, 3);
  assert.ok(artifacts.every((artifact) => artifact.contentHash.startsWith("sha256:")));

  const badBody = new FormData();
  badBody.append("kind", "file");
  badBody.append("relativePaths", JSON.stringify(["../outside.txt"]));
  badBody.append("files", new Blob(["bad"]), "outside.txt");
  const badResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/attachments`, {
    method: "POST",
    body: badBody,
  });
  assert.equal(badResponse.status, 400);
  await assert.rejects(fs.access(path.join(home, "outside.txt")));
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function poll(operation) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for server.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
