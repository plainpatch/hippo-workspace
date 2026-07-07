(function () {
  const DEFAULTS = {
    wrapperUrl: "http://localhost:8787",
    defaultKnowledgeDir: "浏览器剪藏",
    defaultProjectId: "",
  };

  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.error(error));

    chrome.contextMenus.create({
      id: "hippo-save-selection",
      title: "保存选中文本到 Hippo 知识库",
      contexts: ["selection"],
    });
  });

  chrome.runtime.onStartup.addListener(() => {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.error(error));
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== "hippo-save-selection") return;
    try {
      const settings = await getStorage(DEFAULTS);
      const textContent = String(info.selectionText || "").trim();
      if (!textContent) throw new Error("没有选中文本。");

      const relativeDir = settings.defaultKnowledgeDir || DEFAULTS.defaultKnowledgeDir;
      const result = await request(settings, "/api/knowledge/text", {
        method: "POST",
        body: {
          relativeDir,
          title: tab?.title || "网页选中文本",
          textContent,
          metadata: {
            source: "chrome-extension-context-menu",
            url: tab?.url,
            pageTitle: tab?.title,
          },
        },
      });

      if (settings.defaultProjectId) {
        await attachKnowledgeRef(settings, settings.defaultProjectId, relativeDir || result.relativePath);
      }
      await setBadge("OK", "#10b981");
    } catch (error) {
      console.error(error);
      await setBadge("ERR", "#ef4444");
    }
  });

  async function attachKnowledgeRef(settings, projectId, ref) {
    const current = await request(settings, `/api/agent-workspaces/${encodeURIComponent(projectId)}`);
    const project = current.agentWorkspace;
    const refs = [...new Set([...(project.knowledgeRefs || []), ref].filter(Boolean))];
    await request(settings, `/api/agent-workspaces/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: { knowledgeRefs: refs },
    });
  }

  async function request(settings, path, options = {}) {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const response = await fetch(`${normalizeWrapperUrl(settings.wrapperUrl)}${path}`, {
      ...options,
      headers,
      body,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
    return data;
  }

  function getStorage(defaults) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(defaults, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  async function setBadge(text, color) {
    await actionSetBadgeBackgroundColor({ color });
    await actionSetBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1800);
  }

  function actionSetBadgeBackgroundColor(options) {
    return new Promise((resolve, reject) => {
      chrome.action.setBadgeBackgroundColor(options, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function actionSetBadgeText(options) {
    return new Promise((resolve, reject) => {
      chrome.action.setBadgeText(options, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function normalizeWrapperUrl(value) {
    return String(value || DEFAULTS.wrapperUrl).replace(/\/+$/, "");
  }
})();
