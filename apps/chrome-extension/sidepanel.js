(function () {
  const DEFAULTS = {
    wrapperUrl: "http://localhost:8787",
    defaultKnowledgeDir: "浏览器剪藏",
    defaultProjectId: "",
  };

  const elements = {};
  const messagesByProject = new Map();
  let settings = { ...DEFAULTS };
  let projects = [];
  let activeProjectId = "";
  let pageSnapshot = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindElements();
    bindEvents();
    settings = { ...DEFAULTS, ...(await storageGet(DEFAULTS)) };
    activeProjectId = settings.defaultProjectId || "";
    elements.wrapperUrlInput.value = settings.wrapperUrl;
    elements.knowledgeDirInput.value = settings.defaultKnowledgeDir;
    await Promise.allSettled([loadRuntime(), refreshPageSnapshot()]);
    switchTab("chat");
  }

  function bindElements() {
    for (const id of [
      "statusLine",
      "openAppBtn",
      "projectSelect",
      "reloadBtn",
      "chatStream",
      "chatForm",
      "messageInput",
      "dryRunInput",
      "sendBtn",
      "knowledgeDirInput",
      "titleInput",
      "captureModeSelect",
      "previewText",
      "refreshSourceBtn",
      "clipBtn",
      "wrapperUrlInput",
      "saveSettingsBtn",
      "projectDetails",
    ]) {
      elements[id] = document.getElementById(id);
    }
  }

  function bindEvents() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.tab));
    });
    elements.reloadBtn.addEventListener("click", loadRuntime);
    elements.openAppBtn.addEventListener("click", openApp);
    elements.projectSelect.addEventListener("change", selectProject);
    elements.chatForm.addEventListener("submit", sendMessage);
    elements.refreshSourceBtn.addEventListener("click", refreshPageSnapshot);
    elements.captureModeSelect.addEventListener("change", renderPreview);
    elements.clipBtn.addEventListener("click", clipToKnowledge);
    elements.saveSettingsBtn.addEventListener("click", saveSettings);
    elements.knowledgeDirInput.addEventListener("change", saveSettings);
  }

  async function loadRuntime() {
    try {
      setStatus("连接中...");
      const [status, projectData] = await Promise.all([
        request("/api/status"),
        request("/api/agent-workspaces"),
      ]);
      projects = projectData.agentWorkspaces || [];
      if (activeProjectId && !projects.some((project) => project.id === activeProjectId)) {
        activeProjectId = "";
      }
      if (!activeProjectId && projects.length) activeProjectId = projects[0].id;
      renderProjects();
      renderActiveProject();
      setStatus(
        `Wrapper 在线 · ${status.anythingllm?.auth?.authenticated ? "AnythingLLM 已认证" : "AnythingLLM 未认证"}`,
        status.anythingllm?.auth?.authenticated ? "ok" : "warn"
      );
    } catch (error) {
      setStatus(`连接失败：${error.message}`, "error");
      renderActiveProject();
    }
  }

  function renderProjects() {
    elements.projectSelect.innerHTML = [
      `<option value="">选择项目</option>`,
      ...projects.map((project) =>
        `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`
      ),
    ].join("");
    elements.projectSelect.value = activeProjectId;
  }

  function renderActiveProject() {
    const project = getActiveProject();
    elements.messageInput.disabled = !project;
    elements.sendBtn.disabled = !project;
    elements.messageInput.placeholder = project ? `向「${project.name}」提问` : "请先选择项目";
    renderProjectDetails(project);

    if (project && !messagesByProject.has(project.id)) {
      messagesByProject.set(project.id, [{
        role: "assistant",
        text: `已加载项目「${project.name}」。知识库引用：${(project.knowledgeRefs || []).join("、") || "未配置"}。`,
      }]);
    }
    renderMessages();
  }

  function renderMessages() {
    const messages = messagesByProject.get(activeProjectId) || [];
    elements.chatStream.innerHTML = messages.map((message) => `
      <article class="message ${message.role}">
        <div class="messageMeta">${message.role === "user" ? "你" : "Hippo Agent"}</div>
        <div class="messageText">${formatMessage(message.text)}</div>
      </article>
    `).join("");
    elements.chatStream.scrollTop = elements.chatStream.scrollHeight;
  }

  function renderProjectDetails(project) {
    elements.projectDetails.innerHTML = project ? kv({
      项目: project.name,
      Workspace: project.localWorkspaceFolderName || project.anythingllmWorkspaceSlug,
      AnythingLLM: project.anythingllmWorkspaceSlug,
      知识引用: (project.knowledgeRefs || []).join("、") || "未配置",
      Skill: `${(project.skills || []).length} 个`,
    }) : kv({ 项目: "未选择", 状态: "请在顶部选择项目" });
  }

  async function selectProject() {
    activeProjectId = elements.projectSelect.value;
    settings.defaultProjectId = activeProjectId;
    await storageSet(settings);
    renderActiveProject();
  }

  async function sendMessage(event) {
    event.preventDefault();
    const project = getActiveProject();
    const task = elements.messageInput.value.trim();
    if (!project || !task) return;

    pushMessage(project.id, { role: "user", text: task });
    elements.messageInput.value = "";
    try {
      const data = await request(`/api/agent-workspaces/${encodeURIComponent(project.id)}/execute`, {
        method: "POST",
        body: {
          task,
          dryRun: elements.dryRunInput.checked,
          context: pageSnapshot ? { page: { title: pageSnapshot.title, url: pageSnapshot.url } } : undefined,
        },
      });
      pushMessage(project.id, {
        role: "assistant",
        text: elements.dryRunInput.checked ? `已生成编排请求：\n\n${data.request.message}` : extractAgentResponse(data),
      });
    } catch (error) {
      pushMessage(project.id, { role: "assistant", text: `执行失败：${error.message}` });
    }
  }

  function pushMessage(projectId, message) {
    const messages = messagesByProject.get(projectId) || [];
    messages.push(message);
    messagesByProject.set(projectId, messages);
    renderMessages();
  }

  async function refreshPageSnapshot() {
    try {
      const [tab] = await tabsQuery({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("无法读取当前标签页。");
      const [result] = await executeScript({
        target: { tabId: tab.id },
        func: collectPageSnapshot,
      });
      pageSnapshot = result?.result || {};
      if (!elements.titleInput.value) elements.titleInput.value = pageSnapshot.title || tab.title || "";
      renderPreview();
    } catch (error) {
      elements.previewText.value = `读取页面失败：${error.message}`;
    }
  }

  function renderPreview() {
    if (!pageSnapshot) return;
    elements.previewText.value = buildClipText();
  }

  async function clipToKnowledge() {
    try {
      await saveSettings();
      const project = getActiveProject();
      const textContent = elements.previewText.value.trim();
      if (!textContent) throw new Error("没有可入库的内容。");
      const relativeDir = elements.knowledgeDirInput.value.trim() || DEFAULTS.defaultKnowledgeDir;
      const title = elements.titleInput.value.trim() || pageSnapshot?.title || "网页剪藏";
      const result = await request("/api/knowledge/text", {
        method: "POST",
        body: {
          relativeDir,
          title,
          textContent,
          metadata: {
            source: "chrome-extension-sidepanel",
            url: pageSnapshot?.url,
            pageTitle: pageSnapshot?.title,
            captureMode: elements.captureModeSelect.value,
            projectId: project?.id,
          },
        },
      });

      if (project) {
        await attachKnowledgeRef(project.id, relativeDir || result.relativePath);
      }
      setStatus(project ? "已入库并关联当前项目。" : "已入库到系统知识库。", "ok");
      await loadRuntime();
    } catch (error) {
      setStatus(`入库失败：${error.message}`, "error");
    }
  }

  async function attachKnowledgeRef(projectId, ref) {
    const project = projects.find((item) => item.id === projectId)
      || (await request(`/api/agent-workspaces/${encodeURIComponent(projectId)}`)).agentWorkspace;
    const refs = [...new Set([...(project.knowledgeRefs || []), ref].filter(Boolean))];
    const updated = await request(`/api/agent-workspaces/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: { knowledgeRefs: refs },
    });
    projects = projects.map((item) => item.id === projectId ? updated.agentWorkspace : item);
  }

  async function saveSettings() {
    settings = {
      wrapperUrl: normalizeWrapperUrl(elements.wrapperUrlInput.value),
      defaultKnowledgeDir: elements.knowledgeDirInput.value.trim() || DEFAULTS.defaultKnowledgeDir,
      defaultProjectId: activeProjectId,
    };
    await storageSet(settings);
    elements.wrapperUrlInput.value = settings.wrapperUrl;
    setStatus("配置已保存。", "ok");
  }

  function switchTab(name) {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === name);
    });
    for (const panel of ["chat", "clip", "settings"]) {
      document.getElementById(`${panel}Tab`).classList.toggle("active", panel === name);
    }
  }

  function openApp() {
    chrome.tabs.create({ url: normalizeWrapperUrl(elements.wrapperUrlInput.value) });
  }

  function getActiveProject() {
    return projects.find((project) => project.id === activeProjectId) || null;
  }

  function buildClipText() {
    if (!pageSnapshot) return "";
    if (elements.captureModeSelect.value === "page") {
      return [
        `# ${pageSnapshot.title || "网页剪藏"}`,
        pageSnapshot.url || "",
        pageSnapshot.description ? `\n${pageSnapshot.description}` : "",
        pageSnapshot.selection ? `\n## 选中文本\n${pageSnapshot.selection}` : "",
        pageSnapshot.bodyText ? `\n## 页面正文\n${pageSnapshot.bodyText}` : "",
      ].filter(Boolean).join("\n");
    }
    return pageSnapshot.selection || pageSnapshot.description || pageSnapshot.bodyText || "";
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(stripEmpty(body));
    }
    const response = await fetch(`${normalizeWrapperUrl(elements.wrapperUrlInput.value || settings.wrapperUrl)}${path}`, {
      ...options,
      headers,
      body,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
    return data;
  }

  function extractAgentResponse(data) {
    const result = data.result || {};
    return result.textResponse || result.text || result.message || JSON.stringify(result, null, 2);
  }

  function setStatus(message, kind = "") {
    elements.statusLine.textContent = message;
    elements.statusLine.className = kind;
  }

  function normalizeWrapperUrl(value) {
    return String(value || DEFAULTS.wrapperUrl).replace(/\/+$/, "");
  }

  function storageGet(defaults) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(defaults, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(value, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function tabsQuery(query) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query(query, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(tabs);
      });
    });
  }

  function executeScript(options) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(options, (results) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(results);
      });
    });
  }

  function kv(entries) {
    return Object.entries(entries)
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join("");
  }

  function formatMessage(value) {
    return escapeHtml(value).replace(/\n/g, "<br>");
  }

  function stripEmpty(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item !== undefined && item !== "")
    );
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

function collectPageSnapshot() {
  const selection = String(window.getSelection?.() || "").trim();
  const description = document.querySelector("meta[name='description']")?.content || "";
  const bodyText = (document.body?.innerText || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 12000);
  return {
    title: document.title,
    url: location.href,
    description,
    selection,
    bodyText,
  };
}
