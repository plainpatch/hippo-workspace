import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HippoSkillInstaller } from "../src/skill-installer.js";

test("hippo-agent-builder installs and updates inside CODEX_HOME skills", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hippo-skill-installer-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sourceRoot = path.join(home, "bundled-skills");
  const source = path.join(sourceRoot, "hippo-agent-builder");
  const codexHome = path.join(home, "codex");
  await fs.mkdir(path.join(source, "references"), { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "version one\n");
  await fs.writeFile(path.join(source, "references", "guide.md"), "guide\n");
  const installer = new HippoSkillInstaller({ sourceRoot, codexHome });

  assert.equal((await installer.getAgentBuilderStatus()).installed, false);
  const installed = await installer.installAgentBuilder();
  assert.equal(installed.installed, true);
  assert.equal(installed.requiresNewSession, true);
  assert.equal(
    await fs.readFile(path.join(codexHome, "skills", "hippo-agent-builder", "references", "guide.md"), "utf8"),
    "guide\n"
  );

  const destination = path.join(codexHome, "skills", "hippo-agent-builder");
  await fs.writeFile(path.join(destination, "stale.md"), "stale\n");
  await fs.writeFile(path.join(source, "SKILL.md"), "version two\n");
  await installer.installAgentBuilder();
  assert.equal(await fs.readFile(path.join(destination, "SKILL.md"), "utf8"), "version two\n");
  await assert.rejects(fs.access(path.join(destination, "stale.md")), { code: "ENOENT" });
});
