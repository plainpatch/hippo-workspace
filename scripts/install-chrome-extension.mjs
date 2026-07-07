#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionDir = path.join(repoRoot, "apps", "chrome-extension");
const manifestPath = path.join(extensionDir, "manifest.json");
const profileDir = path.join(repoRoot, ".chrome-extension-profile");

main().catch((error) => {
  console.error(`\n安装失败：${error.message}`);
  process.exit(1);
});

async function main() {
  validateExtension();
  const browser = findBrowser();
  if (!browser) {
    throw new Error("未找到 Chrome、Edge 或 Chromium。请先安装浏览器，或手动在 chrome://extensions 加载 apps/chrome-extension。");
  }

  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:8787",
  ];

  const child = spawn(browser.command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log("Hippo Chrome 插件已启动。");
  console.log(`浏览器：${browser.name}`);
  console.log(`扩展目录：${extensionDir}`);
  console.log(`独立配置目录：${profileDir}`);
  console.log("\n说明：这是开发模式的一键加载，会启动一个独立浏览器配置，不会修改你的主 Chrome 配置。");
}

function validateExtension() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`找不到扩展 manifest：${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) {
    throw new Error("扩展必须是 Manifest V3。");
  }
  for (const file of ["sidepanel.html", "sidepanel.js", "sidepanel.css", "background.js"]) {
    const target = path.join(extensionDir, file);
    if (!fs.existsSync(target)) throw new Error(`扩展文件缺失：${target}`);
  }
}

function findBrowser() {
  const candidates = getBrowserCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate.command)) || findBrowserFromPath();
}

function getBrowserCandidates() {
  const platform = os.platform();
  if (platform === "darwin") {
    return [
      {
        name: "Google Chrome",
        command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      {
        name: "Google Chrome Canary",
        command: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      },
      {
        name: "Microsoft Edge",
        command: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      },
      {
        name: "Chromium",
        command: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      },
    ];
  }
  if (platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    return roots.flatMap((root) => [
      { name: "Google Chrome", command: path.join(root, "Google", "Chrome", "Application", "chrome.exe") },
      { name: "Microsoft Edge", command: path.join(root, "Microsoft", "Edge", "Application", "msedge.exe") },
      { name: "Chromium", command: path.join(root, "Chromium", "Application", "chrome.exe") },
    ]);
  }
  return [
    { name: "Google Chrome", command: "/usr/bin/google-chrome" },
    { name: "Google Chrome Stable", command: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", command: "/usr/bin/chromium" },
    { name: "Chromium Browser", command: "/usr/bin/chromium-browser" },
    { name: "Microsoft Edge", command: "/usr/bin/microsoft-edge" },
  ];
}

function findBrowserFromPath() {
  const names = os.platform() === "win32"
    ? ["chrome.exe", "msedge.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const name of names) {
      const command = path.join(entry, name);
      if (fs.existsSync(command)) return { name, command };
    }
  }
  return null;
}
