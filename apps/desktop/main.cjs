const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..", "..");
const preferredPort = Number(process.env.WRAPPER_PORT || 8787);
let port = preferredPort;
let appUrl = `http://127.0.0.1:${port}`;
let sidecar = null;
let mainWindow = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  await ensureWrapperRunning();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (sidecar) sidecar.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

async function ensureWrapperRunning() {
  if (process.env.HIPPO_REUSE_EXISTING_WRAPPER === "1" && await isHealthy(appUrl)) return;

  port = process.env.WRAPPER_PORT ? preferredPort : await findAvailablePort(preferredPort);
  appUrl = `http://127.0.0.1:${port}`;

  const nodePath = resolveNodeExecutable();
  sidecar = spawn(nodePath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WRAPPER_PORT: String(port),
      ANYTHINGLLM_BASE_URL: process.env.ANYTHINGLLM_BASE_URL || "http://localhost:3001",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  sidecar.stdout.on("data", (chunk) => console.log(`[hippo-wrapper] ${chunk}`.trim()));
  sidecar.stderr.on("data", (chunk) => console.error(`[hippo-wrapper] ${chunk}`.trim()));
  sidecar.on("error", (error) => console.error(`[hippo-wrapper] failed to start: ${error.message}`));
  sidecar.unref();

  const started = await waitForHealth(15_000);
  if (!started) {
    throw new Error(`Wrapper service did not become healthy at ${appUrl}.`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "Hippo Agent 工作台",
    backgroundColor: "#f4f6f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(appUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function resolveNodeExecutable() {
  const candidates = [
    process.env.HIPPO_NODE_PATH,
    process.env.npm_node_execpath,
    process.env.NODE,
    process.versions.electron ? "" : process.execPath,
    "node",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "node") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

function waitForHealth(timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isHealthy(appUrl)) return resolve(true);
      if (Date.now() - startedAt > timeoutMs) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function findAvailablePort(startAt) {
  for (let candidate = startAt; candidate < startAt + 20; candidate += 1) {
    if (!(await isPortListening(candidate))) return candidate;
  }
  throw new Error(`No available wrapper port found from ${startAt} to ${startAt + 19}.`);
}

function isHealthy(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function isPortListening(candidate) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${candidate}/api/health`, (res) => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(300, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}
