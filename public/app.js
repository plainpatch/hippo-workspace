const state = {
  projects: [],
  workspaces: [],
  knowledge: null,
  status: null,
  activeProjectId: null,
  messages: [],
};

bindEvents();
setDrawerOpen(false);
refreshAll();

function bindEvents() {
  document.getElementById("refreshBtn").addEventListener("click", refreshAll);
  document.getElementById("newChatBtn").addEventListener("click", clearChat);
  document.getElementById("searchBtn").addEventListener("click", () => toast("搜索入口已预留。"));
  document.getElementById("knowledgeBtn").addEventListener("click", openDrawer);
  document.getElementById("mcpBtn").addEventListener("click", showMcpMessage);
  document.getElementById("runtimeBtn").addEventListener("click", showRuntimeMessage);
  document.getElementById("settingsBtn").addEventListener("click", openDrawer);
  document.getElementById("createProjectBtn").addEventListener("click", () => openProjectForm());
  document.getElementById("projectConfigBtn").addEventListener("click", () => openProjectForm(getActiveProject()));
  document.getElementById("closeDrawerBtn").addEventListener("click", closeDrawer);
  document.getElementById("attachTextBtn").addEventListener("click", openDrawer);

  document.getElementById("projectForm").addEventListener("submit", saveProject);
  document.getElementById("composerForm").addEventListener("submit", sendMessage);
  document.getElementById("quickTextForm").addEventListener("submit", uploadTextToProject);
}

async function refreshAll() {
  await checkStatus();
  await Promise.allSettled([loadProjects(), loadWorkspaces(), loadKnowledge()]);
}

async function checkStatus() {
  try {
    const data = await request("/api/status");
    state.status = data;
    document.getElementById("runtimeSummary").textContent = "Wrapper 在线";
    renderRuntimePills([
      ["Wrapper", "ok"],
      ["AnythingLLM", data.anythingllm.auth?.authenticated ? "ok" : "warn"],
    ]);
    renderRuntimeDetails(data);
  } catch (error) {
    document.getElementById("runtimeSummary").textContent = "运行异常";
    renderRuntimePills([["Wrapper", "error"]]);
    document.getElementById("runtimeDetails").innerHTML = kv({ 错误: error.message });
  }
}

async function loadProjects() {
  const data = await request("/api/agent-workspaces");
  state.projects = data.agentWorkspaces || [];
  if (!state.activeProjectId && state.projects.length) {
    state.activeProjectId = state.projects[0].id;
  }
  if (state.activeProjectId && !state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0]?.id || null;
  }
  renderProjectList();
  renderActiveProject();
}

async function loadWorkspaces() {
  const data = await request("/api/workspaces");
  const workspaces = data.workspaces || data.workspace || data;
  state.workspaces = Array.isArray(workspaces) ? workspaces : [];
  renderWorkspaceOptions();
}

async function loadKnowledge() {
  const data = await request("/api/knowledge");
  state.knowledge = data;
  renderKnowledgeTree(getActiveProject()?.knowledgeRefs || []);
}

function renderProjectList() {
  const target = document.getElementById("projectList");
  if (!state.projects.length) {
    target.innerHTML = `<div class="emptyBlock">还没有项目。点击“新建项目”开始配置。</div>`;
    return;
  }
  target.innerHTML = state.projects.map((project) => `
    <button class="projectItem ${project.id === state.activeProjectId ? "active" : ""}" data-project-id="${escapeHtml(project.id)}" type="button">
      <span class="projectGlyph">▣</span>
      <span>
        <strong>${escapeHtml(project.name)}</strong>
        <small>${escapeHtml(project.description || project.anythingllmWorkspaceSlug)}</small>
      </span>
    </button>
  `).join("");

  target.querySelectorAll("[data-project-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeProjectId = button.dataset.projectId;
      clearChat(false);
      renderProjectList();
      renderActiveProject();
    });
  });
}

function renderActiveProject() {
  const project = getActiveProject();
  const name = document.getElementById("activeProjectName");
  const meta = document.getElementById("activeProjectMeta");
  const configButton = document.getElementById("projectConfigBtn");
  const input = document.getElementById("messageInput");

  if (!project) {
    name.textContent = "选择或创建项目";
    meta.textContent = "左侧项目用于定义默认 Agent、可访问 Skill 和 RAG 范围。";
    configButton.textContent = "新建项目";
    input.disabled = true;
    input.placeholder = "请先创建项目";
    if (!state.messages.length) {
      state.messages = [{
        role: "assistant",
        text: "先在左侧创建一个项目。项目会绑定 AnythingLLM 工作空间，并保存默认 Agent、Skill 与 RAG 范围。",
      }];
      renderMessages();
    }
    return;
  }

  name.textContent = project.name;
  meta.textContent = `${project.localWorkspaceFolderName || project.anythingllmWorkspaceSlug} · ${project.defaultMode || "query"} · ${(project.skills || []).length} 个 Skill · ${(project.knowledgeRefs || []).length} 个知识引用`;
  configButton.textContent = "项目配置";
  input.disabled = false;
  input.placeholder = `向「${project.name}」提问，或描述要执行的任务`;
  if (!state.messages.length) {
    state.messages = [{
      role: "assistant",
      text: `当前项目已绑定 AnythingLLM 工作空间「${project.anythingllmWorkspaceSlug}」，本地工作区为「${project.localWorkspacePath || "未记录"}」。可以在“项目配置”里调整预置 Agent、Skill 和系统知识库引用。`,
    }];
    renderMessages();
  }
}

function renderMessages() {
  const stream = document.getElementById("chatStream");
  stream.innerHTML = state.messages.map((message) => `
    <article class="message ${message.role}">
      <div class="messageAvatar">${message.role === "user" ? "你" : "H"}</div>
      <div class="messageBody">
        <div class="messageMeta">${message.role === "user" ? "你" : "Hippo Agent"}</div>
        <div class="messageText">${formatMessage(message.text)}</div>
      </div>
    </article>
  `).join("");
  stream.scrollTop = stream.scrollHeight;
}

function renderWorkspaceOptions() {
  const options = [`<option value="">新建或选择已有工作空间</option>`].concat(
    state.workspaces.map((workspace) =>
      `<option value="${escapeHtml(workspace.slug || "")}">${escapeHtml(workspace.name || workspace.slug)}</option>`
    )
  ).join("");
  document.getElementById("workspaceSelect").innerHTML = options;
}

function renderKnowledgeTree(selectedRefs = []) {
  const target = document.getElementById("knowledgeTree");
  if (!target) return;
  const tree = state.knowledge?.tree;
  if (!tree || !tree.children?.length) {
    target.innerHTML = `<div class="emptyBlock">系统知识库暂无内容。可先在下方入库文本，或通过 API 上传文件。</div>`;
    return;
  }
  const selected = new Set(selectedRefs || []);
  target.innerHTML = tree.children.map((item) => renderKnowledgeNode(item, selected, 0)).join("");
}

function renderRuntimePills(items) {
  document.getElementById("runtimePills").innerHTML = items
    .map(([label, status]) => `<span class="pill ${status}">${escapeHtml(label)}</span>`)
    .join("");
}

function renderRuntimeDetails(data) {
  document.getElementById("runtimeDetails").innerHTML = kv({
    "Wrapper": `:${data.wrapper.port}`,
    "AnythingLLM": data.anythingllm.baseUrl,
    "API 认证": data.anythingllm.auth?.authenticated ? "已认证" : "未认证",
    "MCP": "http://localhost:8787/mcp",
    "Agent Store": data.wrapper.agentStorePath || "",
  });
}

async function saveProject(event) {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  const id = form.get("id");
  const body = {
    name: form.get("name"),
    description: form.get("description"),
    systemPrompt: form.get("systemPrompt"),
    skills: parseSkills(form.get("skills")),
    anythingllmWorkspaceSlug: form.get("anythingllmWorkspaceSlug") || undefined,
    createAnythingllmWorkspace: Boolean(form.get("createAnythingllmWorkspace")),
    knowledgeRefs: [...formNode.querySelectorAll("[name='knowledgeRefs']:checked")].map((item) => item.value),
    ragDocumentNames: splitLinesOrComma(form.get("ragDocumentNames")),
    defaultMode: form.get("defaultMode"),
    topN: Number(form.get("topN") || 4),
  };

  const result = id
    ? await request(`/api/agent-workspaces/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stripEmpty(body)),
      })
    : await submitJson("/api/agent-workspaces", body, false);

  state.activeProjectId = result.agentWorkspace.id;
  await Promise.allSettled([loadProjects(), loadWorkspaces()]);
  closeDrawer();
  toast("项目配置已保存。");
}

async function sendMessage(event) {
  event.preventDefault();
  const project = getActiveProject();
  if (!project) {
    openProjectForm();
    return;
  }

  const form = new FormData(event.currentTarget);
  const task = String(form.get("message") || "").trim();
  if (!task) return;

  state.messages.push({ role: "user", text: task });
  renderMessages();
  document.getElementById("messageInput").value = "";

  const payload = {
    task,
    mode: form.get("mode") || undefined,
    dryRun: Boolean(form.get("dryRun")),
  };

  try {
    const data = await submitJson(`/api/agent-workspaces/${encodeURIComponent(project.id)}/execute`, payload, false);
    const text = payload.dryRun
      ? `已生成编排请求：\n\n${data.request.message}`
      : extractAgentResponse(data);
    state.messages.push({ role: "assistant", text });
  } catch (error) {
    state.messages.push({ role: "assistant", text: `执行失败：${error.message}` });
  }
  renderMessages();
}

async function uploadTextToProject(event) {
  event.preventDefault();
  const project = getActiveProject();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  const relativeDir = String(form.get("relativeDir") || "").trim();
  const data = await submitJson("/api/knowledge/text", {
    relativeDir,
    title: form.get("title"),
    textContent: form.get("textContent"),
    metadata: project ? { projectId: project.id } : {},
  });
  if (project) {
    const refs = new Set([...(project.knowledgeRefs || []), relativeDir || data.relativePath]);
    await request(`/api/agent-workspaces/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ knowledgeRefs: [...refs] }),
    });
  }
  formNode.reset();
  await Promise.allSettled([loadProjects(), loadKnowledge()]);
  toast(project ? "文档已入库到系统知识库，并关联当前项目。" : "文档已入库到系统知识库。");
}

function openProjectForm(project = undefined) {
  const drawer = document.getElementById("configDrawer");
  const form = document.getElementById("projectForm");
  const active = project || getActiveProject();
  form.reset();
  if (active && project !== undefined) {
    form.elements.id.value = active.id;
    form.elements.name.value = active.name || "";
    form.elements.description.value = active.description || "";
    form.elements.systemPrompt.value = active.systemPrompt || "";
    form.elements.skills.value = (active.skills || []).map(formatSkillLine).join("\n");
    form.elements.anythingllmWorkspaceSlug.value = active.anythingllmWorkspaceSlug || "";
    form.elements.ragDocumentNames.value = (active.explicitRagDocumentNames || []).join("\n");
    form.elements.defaultMode.value = active.defaultMode || "query";
    form.elements.topN.value = active.topN || 4;
    form.elements.createAnythingllmWorkspace.checked = false;
  } else {
    form.elements.id.value = "";
    form.elements.createAnythingllmWorkspace.checked = true;
    form.elements.defaultMode.value = "query";
    form.elements.topN.value = 4;
  }
  renderKnowledgeTree(active?.knowledgeRefs || []);
  setDrawerOpen(true);
}

function openDrawer() {
  openProjectForm(getActiveProject());
}

function closeDrawer() {
  setDrawerOpen(false);
}

function setDrawerOpen(open) {
  const drawer = document.getElementById("configDrawer");
  drawer.classList.toggle("open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  if (open) {
    drawer.removeAttribute("inert");
  } else {
    drawer.setAttribute("inert", "");
  }
}

function showMcpMessage() {
  state.messages.push({
    role: "assistant",
    text: "MCP 端点：http://localhost:8787/mcp\n\n可用工具包括 agent_create_workspace、agent_update_rag_scope、agent_execute_task，以及 AnythingLLM RAG 更新和检索工具。",
  });
  renderMessages();
}

function showRuntimeMessage() {
  const status = state.status;
  state.messages.push({
    role: "assistant",
    text: status
      ? `Wrapper :${status.wrapper.port}\nAnythingLLM：${status.anythingllm.baseUrl}\n认证：${status.anythingllm.auth?.authenticated ? "已认证" : "未认证"}`
      : "运行状态尚未加载。",
  });
  renderMessages();
}

function clearChat(resetWelcome = true) {
  state.messages = [];
  if (resetWelcome) renderActiveProject();
  renderMessages();
}

function getActiveProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

async function submitJson(url, body, showToast = true) {
  const data = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stripEmpty(body)),
  });
  if (showToast) toast("请求已完成。");
  return data;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.error || data.message || `请求失败：${response.status}`;
    toast(message, true);
    throw new Error(message);
  }
  return data;
}

function extractAgentResponse(data) {
  const result = data.result || {};
  return result.textResponse || result.text || result.message || JSON.stringify(result, null, 2);
}

function parseSkills(value) {
  return splitLines(value).map((line) => {
    const [name, ...description] = line.split(":");
    return {
      name: name.trim(),
      description: description.join(":").trim() || undefined,
    };
  });
}

function formatSkillLine(skill) {
  return skill.description ? `${skill.name}: ${skill.description}` : skill.name;
}

function renderKnowledgeNode(item, selected, depth) {
  const checked = selected.has(item.path) ? "checked" : "";
  const indent = depth * 14;
  const count = item.type === "folder" ? countKnowledgeDocs(item) : item.documentNames?.length || 0;
  const children = item.children?.length
    ? `<div class="knowledgeChildren">${item.children.map((child) => renderKnowledgeNode(child, selected, depth + 1)).join("")}</div>`
    : "";
  return `
    <label class="knowledgeNode ${item.type}" style="--depth:${indent}px">
      <input name="knowledgeRefs" type="checkbox" value="${escapeHtml(item.path)}" ${checked} />
      <span>${item.type === "folder" ? "▸" : "·"}</span>
      <strong>${escapeHtml(item.name)}</strong>
      <small>${count} 文档</small>
    </label>
    ${children}
  `;
}

function countKnowledgeDocs(item) {
  if (item.type === "file") return item.documentNames?.length || 0;
  return (item.children || []).reduce((sum, child) => sum + countKnowledgeDocs(child), 0);
}

function splitLines(value) {
  return String(value || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLinesOrComma(value) {
  return String(value || "")
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripEmpty(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== "")
  );
}

function kv(entries) {
  return Object.entries(entries)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
}

function formatMessage(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function toast(message, error = false) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => node.classList.remove("show"), 3000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
