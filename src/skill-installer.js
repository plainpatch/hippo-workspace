import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HIPPO_AGENT_BUILDER_SKILL_NAME = "hippo-agent-builder";

export class HippoSkillInstaller {
  constructor({ sourceRoot, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") }) {
    this.sourcePath = path.resolve(sourceRoot, HIPPO_AGENT_BUILDER_SKILL_NAME);
    this.destinationPath = path.resolve(codexHome, "skills", HIPPO_AGENT_BUILDER_SKILL_NAME);
  }

  async getAgentBuilderStatus() {
    await assertSkillSource(this.sourcePath);
    return {
      name: HIPPO_AGENT_BUILDER_SKILL_NAME,
      installed: await pathExists(path.join(this.destinationPath, "SKILL.md")),
      destinationPath: this.destinationPath,
    };
  }

  async installAgentBuilder() {
    await assertSkillSource(this.sourcePath);
    await fs.mkdir(path.dirname(this.destinationPath), { recursive: true });
    await fs.rm(this.destinationPath, { recursive: true, force: true });
    await fs.cp(this.sourcePath, this.destinationPath, { recursive: true, force: true });
    return {
      name: HIPPO_AGENT_BUILDER_SKILL_NAME,
      installed: true,
      destinationPath: this.destinationPath,
      requiresNewSession: true,
    };
  }
}

async function assertSkillSource(sourcePath) {
  if (!await pathExists(path.join(sourcePath, "SKILL.md"))) {
    throw new Error(`Bundled Skill source was not found: ${sourcePath}`);
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
