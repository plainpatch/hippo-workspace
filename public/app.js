const state = {
  projects: [],
  agents: [],
  knowledge: null,
  status: null,
  activeProjectId: null,
  activeConversationId: null,
  conversations: [],
  collapsedProjectIds: new Set(),
  currentView: "chat",
  messages: [],
};

const icons = {
  project: `<svg class="projectGlyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="15" height="18" rx="2.5"></rect><path d="M3 7h4"></path><path d="M3 12h4"></path><path d="M3 17h4"></path><path d="M10 8h6"></path><path d="M10 12h6"></path><path d="M10 16h4"></path></svg>`,
  chevron: `<svg class="projectChevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>`,
  options: `<svg class="projectActionIcon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.35"></circle><circle cx="12" cy="12" r="1.35"></circle><circle cx="18" cy="12" r="1.35"></circle></svg>`,
  newConversation: `<svg class="projectActionIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-6"></path><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L11 16l-4 1 1-4 9.5-9.5Z"></path></svg>`,
  pin: `<svg class="pinIcon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5"></path><path d="M14 5 8 11l-1 5 5-1 6-6"></path><path d="m9 15-5 5"></path></svg>`,
  archive: `<svg class="archiveIcon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"></rect><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"></path><path d="M10 13h4"></path></svg>`,
};

bindEvents();
setDrawerOpen(false);
refreshAll();

function bindEvents() {
  const messageInput = document.getElementById("messageInput");
  document.getElementById("refreshBtn").addEventListener("click", refreshAll);
  document.getElementById("newChatBtn").addEventListener("click", () => createConversationForActiveProject());
  document.getElementById("searchBtn").addEventListener("click", () => toast("搜索入口已预留。"));
  document.getElementById("agentsBtn").addEventListener("click", showAgentsPage);
  document.getElementById("knowledgeBtn").addEventListener("click", openDrawer);
  document.getElementById("mcpBtn").addEventListener("click", showMcpMessage);
  document.getElementById("runtimeBtn").addEventListener("click", showRuntimeMessage);
  document.getElementById("settingsBtn").addEventListener("click", openDrawer);
  document.getElementById("createProjectBtn").addEventListener("click", () => openProjectForm());
  document.getElementById("projectConfigBtn").addEventListener("click", () => {
    if (state.currentView === "agents") openAgentForm();
    else openProjectForm(getActiveProject());
  });
  document.getElementById("closeDrawerBtn").addEventListener("click", closeDrawer);
  document.getElementById("attachTextBtn").addEventListener("click", openDrawer);

  document.getElementById("projectForm").addEventListener("submit", saveProject);
  document.getElementById("agentForm").addEventListener("submit", saveAgent);
  document.getElementById("composerForm").addEventListener("submit", sendMessage);
  document.getElementById("quickTextForm").addEventListener("submit", uploadTextToProject);
  messageInput.addEventListener("input", () => resizeComposer(messageInput));
  messageInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    document.getElementById("composerForm").requestSubmit();
  });
}

async function refreshAll() {
  await checkStatus();
  await Promise.allSettled([loadProjects(), loadAgents(), loadKnowledge()]);
}

async function checkStatus() {
  try {
    const data = await request("/api/status");
    state.status = data;
    document.getElementById("runtimeSummary").textContent = "Wrapper 在线";
    renderRuntimePills([
      ["Wrapper", "ok"],
      ["RAG", data.anythingllm.auth?.authenticated ? "ok" : "warn"],
    ]);
    renderRuntimeDetails(data);
  } catch (error) {
    document.getElementById("runtimeSummary").textContent = "运行异常";
    renderRuntimePills([["Wrapper", "error"]]);
    document.getElementById("runtimeDetails").innerHTML = kv({ 错误: error.message });
  }
}

async function loadProjects() {
  const data = await request("/api/projects");
  state.projects = data.projects || [];
  if (!state.activeProjectId && state.projects.length) {
    state.activeProjectId = state.projects[0].id;
  }
  if (state.activeProjectId && !state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0]?.id || null;
    state.activeConversationId = null;
  }
  if (state.activeProjectId) await loadConversations(state.activeProjectId);
  else {
    state.conversations = [];
    state.activeConversationId = null;
    state.messages = [];
    renderProjectList();
  }
  renderActiveProject();
}

async function loadConversations(projectId) {
  const data = await request(`/api/projects/${encodeURIComponent(projectId)}/conversations`);
  state.conversations = data.conversations || [];
  if (state.activeConversationId && !state.conversations.some((item) => item.id === state.activeConversationId)) {
    state.activeConversationId = null;
  }
  if (!state.activeConversationId && state.conversations.length) {
    state.activeConversationId = state.conversations[0].id;
  }
  const active = getActiveConversation();
  state.messages = active?.messages ? [...active.messages] : [];
  renderProjectList();
}

async function loadAgents() {
  const data = await request("/api/agents");
  state.agents = data.agents || [];
  renderAgentOptions();
}

async function loadKnowledge() {
  const data = await request("/api/knowledge");
  state.knowledge = data;
  renderProjectKnowledgeTree([]);
}

function renderProjectList() {
  const target = document.getElementById("projectList");
  if (!state.projects.length) {
    target.innerHTML = `
      <div class="emptyBlock">还没有项目。</div>
      <button class="emptyCreateProject" data-empty-create-project type="button">新建项目</button>
    `;
    target.querySelector("[data-empty-create-project]")?.addEventListener("click", () => openProjectForm());
    return;
  }
  target.innerHTML = state.projects.map((project) => {
    const isActive = project.id === state.activeProjectId;
    const isCollapsed = state.collapsedProjectIds.has(project.id);
    return `
    <div class="projectGroup">
      <div class="projectRow ${isActive ? "active" : ""} ${isCollapsed ? "collapsed" : ""}">
        <button class="projectItem" data-project-id="${escapeHtml(project.id)}" type="button" aria-expanded="${isActive && !isCollapsed}">
          ${icons.project}
          <span class="projectName">
            <strong>${escapeHtml(project.name)}</strong>
          </span>
          ${icons.chevron}
        </button>
        <button class="projectOptionsButton" data-project-options-id="${escapeHtml(project.id)}" type="button" aria-label="项目选项">${icons.options}</button>
        <button class="projectNewConversationButton" data-project-new-conversation-id="${escapeHtml(project.id)}" type="button" aria-label="新增对话">${icons.newConversation}</button>
      </div>
      ${isActive && !isCollapsed ? renderConversationList() : ""}
    </div>
  `;
  }).join("");

  target.querySelectorAll("[data-project-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const projectId = button.dataset.projectId;
      if (projectId === state.activeProjectId) {
        if (state.collapsedProjectIds.has(projectId)) state.collapsedProjectIds.delete(projectId);
        else state.collapsedProjectIds.add(projectId);
        renderProjectList();
        return;
      }
      state.activeProjectId = projectId;
      state.collapsedProjectIds.delete(projectId);
      state.activeConversationId = null;
      await loadConversations(state.activeProjectId);
      renderActiveProject();
    });
  });
  target.querySelectorAll("[data-conversation-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeConversationId = button.dataset.conversationId;
      const conversation = getActiveConversation();
      state.messages = conversation?.messages ? [...conversation.messages] : [];
      renderProjectList();
      renderActiveProject();
    });
  });
  target.querySelectorAll("[data-project-new-conversation-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeProjectId = button.dataset.projectNewConversationId;
      state.collapsedProjectIds.delete(state.activeProjectId);
      await createConversationForActiveProject();
    });
  });
  target.querySelectorAll("[data-project-options-id]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      state.activeProjectId = button.dataset.projectOptionsId;
      await loadConversations(state.activeProjectId);
      openProjectForm(getActiveProject());
    });
  });
}

function renderConversationList() {
  if (!state.conversations.length) {
    return `<div class="conversationList"><div class="conversationEmpty">暂无会话</div></div>`;
  }
  return `
    <div class="conversationList">
      ${state.conversations.slice(0, 5).map((conversation) => `
        <button class="conversationItem ${conversation.id === state.activeConversationId ? "active" : ""}" data-conversation-id="${escapeHtml(conversation.id)}" type="button">
          <span>${escapeHtml(conversation.title || "新对话")}</span>
          <span class="conversationActions" aria-hidden="true">${icons.pin}${icons.archive}</span>
          <small>${formatConversationTime(conversation.updatedAt)}</small>
        </button>
      `).join("")}
      ${state.conversations.length >= 5 ? `<button class="conversationMore" type="button">展开显示</button>` : ""}
    </div>
  `;
}

function renderActiveProject() {
  state.currentView = "chat";
  renderAgentOptions();
  const project = getActiveProject();
  const name = document.getElementById("activeProjectName");
  const meta = document.getElementById("activeProjectMeta");
  const configButton = document.getElementById("projectConfigBtn");
  const input = document.getElementById("messageInput");

  if (!project) {
    name.textContent = "选择或创建项目";
    meta.textContent = "左侧项目是 App 管理的 project；Agent 是全局定义后被 project 引用。";
    configButton.textContent = "新建项目";
    input.disabled = true;
    input.placeholder = "请先创建项目";
    if (!state.messages.length) {
      state.messages = [{
        role: "assistant",
        text: "先在左侧创建一个 project。Project 管理本地目录、可用 Agent 和知识抽屉授权。",
      }];
      renderMessages();
    }
    return;
  }

  name.textContent = project.name;
  meta.textContent = `${project.localWorkspaceFolderName || project.id} · ${state.conversations.length} 个会话 · ${project.knowledgeDrawerRefs?.length || 0} 个知识抽屉 · ${project.agentIds?.length || 0} 个 Agent`;
  configButton.textContent = "项目";
  input.disabled = false;
  input.placeholder = `向「${project.name}」提问；可选加载 Agent`;
  if (!state.messages.length) {
    state.messages = [{
      role: "assistant",
      text: `当前 project 本地目录为「${project.localWorkspacePath || "未记录"}」。对话使用 Codex runtime；AnythingLLM 只作为 RAG provider。`,
    }];
  }
  renderMessages();
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

function showAgentsPage() {
  state.currentView = "agents";
  document.getElementById("activeProjectName").textContent = "智能体";
  document.getElementById("activeProjectMeta").textContent = "Agent 类似可选插件包，可以预置提示词和多个 Skill；不加载 Agent 也能执行。";
  document.getElementById("projectConfigBtn").textContent = "新建 Agent";
  const stream = document.getElementById("chatStream");
  stream.innerHTML = `
    <div class="agentPageHeader">
      <button class="primary" id="createAgentInlineBtn" type="button">新建 Agent</button>
    </div>
    <div class="agentCards">
      ${state.agents.length ? state.agents.map((agent) => `
        <button class="agentCard" data-agent-id="${escapeHtml(agent.id)}" type="button">
          <strong>${escapeHtml(agent.name)}</strong>
          <span>${escapeHtml(agent.description || "未填写说明")}</span>
      <small>${(agent.skills || []).length} 个 Skill · ${(agent.mcpServers || []).length} 个 MCP · ${agent.runtimeId || "codex"}</small>
        </button>
      `).join("") : `<div class="emptyBlock">还没有 Agent。可以先直接使用通用助手执行任务；需要预置提示词或组合 Skill 时再创建 Agent。</div>`}
    </div>
  `;
  document.getElementById("createAgentInlineBtn")?.addEventListener("click", () => openAgentForm());
  stream.querySelectorAll("[data-agent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const agent = state.agents.find((item) => item.id === button.dataset.agentId);
      if (agent) openAgentForm(agent);
    });
  });
}

function renderAgentOptions() {
  const target = document.getElementById("agentSelect");
  if (!target) return;
  const project = getActiveProject();
  const availableAgents = project?.agentIds?.length
    ? state.agents.filter((agent) => project.agentIds.includes(agent.id))
    : state.agents;
  target.innerHTML = [`<option value="">通用助手</option>`].concat(
    availableAgents.map((agent) =>
      `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`
    )
  ).join("");
}

function renderAgentList() {
  const target = document.getElementById("agentList");
  if (!target) return;
  if (!state.agents.length) {
    target.innerHTML = `<div class="emptyBlock">还没有 Agent。填写上方表单即可创建。</div>`;
    return;
  }
  target.innerHTML = state.agents.map((agent) => `
    <button class="agentItem" data-agent-id="${escapeHtml(agent.id)}" type="button">
      <strong>${escapeHtml(agent.name)}</strong>
      <small>${escapeHtml(agent.description || `${(agent.skills || []).length} 个 Skill`)}</small>
    </button>
  `).join("");
  target.querySelectorAll("[data-agent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const agent = state.agents.find((item) => item.id === button.dataset.agentId);
      if (agent) openAgentForm(agent);
    });
  });
}

function renderProjectKnowledgeTree(selectedRefs = []) {
  const target = document.getElementById("projectKnowledgeTree");
  if (!target) return;
  const tree = state.knowledge?.tree;
  const children = Array.isArray(tree?.children) ? tree.children : [];
  if (!children.length) {
    target.innerHTML = `<div class="emptyBlock">系统知识库暂无内容。可先在下方入库文本，或通过 API 上传文件。</div>`;
    return;
  }
  const selected = new Set(selectedRefs || []);
  target.innerHTML = children.map((item) => renderKnowledgeNode(item, selected, 0, true)).join("");
}

function renderProjectAgentPicker(selectedAgentIds = []) {
  const target = document.getElementById("projectAgentPicker");
  if (!target) return;
  if (!state.agents.length) {
    target.innerHTML = `<div class="emptyBlock">还没有全局 Agent。可以稍后在“智能体”中创建。</div>`;
    return;
  }
  const selected = new Set(selectedAgentIds || []);
  target.innerHTML = state.agents.map((agent) => `
    <label class="agentCheck">
      <input name="agentIds" type="checkbox" value="${escapeHtml(agent.id)}" ${selected.has(agent.id) ? "checked" : ""} />
      <span>
        <strong>${escapeHtml(agent.name)}</strong>
        <small>${escapeHtml(agent.description || agent.runtimeId || "codex")}</small>
      </span>
    </label>
  `).join("");
}

function renderRuntimePills(items) {
  document.getElementById("runtimePills").innerHTML = items
    .map(([label, status]) => `<span class="pill ${status}">${escapeHtml(label)}</span>`)
    .join("");
}

function renderRuntimeDetails(data) {
  document.getElementById("runtimeDetails").innerHTML = kv({
    "Wrapper": `:${data.wrapper.port}`,
    "RAG Provider": data.wrapper.settings?.ragProviderId || "anythingllm",
    "Provider URL": data.anythingllm.baseUrl,
    "Provider 认证": data.anythingllm.auth?.authenticated ? "已认证" : "未认证",
    "MCP": `http://localhost:${data.wrapper.port}/mcp`,
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
    agentIds: [...formNode.querySelectorAll("[name='agentIds']:checked")].map((item) => item.value),
    knowledgeDrawerRefs: [...formNode.querySelectorAll("[name='knowledgeDrawerRefs']:checked")].map((item) => item.value),
  };

  const result = id
    ? await request(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stripEmpty(body)),
      })
    : await submitJson("/api/projects", body, false);

  state.activeProjectId = result.project.id;
  state.activeConversationId = null;
  state.conversations = [];
  state.messages = [];
  await loadProjects();
  closeDrawer();
  toast("项目已保存。");
}

async function saveAgent(event) {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  const id = form.get("id");
  const body = {
    name: form.get("name"),
    description: form.get("description"),
    systemPrompt: form.get("systemPrompt"),
    skills: parseSkills(form.get("skills")),
    mcpServers: splitLinesOrComma(form.get("mcpServers")),
    runtimeId: form.get("runtimeId") || "codex",
    ragDocumentNames: splitLinesOrComma(form.get("ragDocumentNames")),
    defaultMode: form.get("defaultMode"),
    topN: Number(form.get("topN") || 4),
  };

  id
    ? await request(`/api/agents/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stripEmpty(body)),
      })
    : await submitJson("/api/agents", body, false);

  await loadAgents();
  renderAgentList();
  closeDrawer();
  toast("Agent 已保存。");
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

  const conversation = await ensureActiveConversation(task);
  state.messages.push({ role: "user", text: task });
  renderMessages();
  await saveActiveConversation();
  const input = document.getElementById("messageInput");
  input.value = "";
  resizeComposer(input);

  const payload = {
    task,
    agentId: form.get("agentId") || undefined,
    mode: form.get("mode") || undefined,
    sessionId: conversation.id,
    dryRun: Boolean(form.get("dryRun")),
  };

  try {
    const assistantMessage = { role: "assistant", text: "正在准备执行..." };
    state.messages.push(assistantMessage);
    renderMessages();
    await streamProjectExecution(project.id, payload, {
      onPrepared() {
        assistantMessage.text = payload.dryRun ? "正在生成编排请求..." : "正在调用 Codex runtime...";
        renderMessages();
      },
      onChunk(chunk) {
        if (!chunk) return;
        if (assistantMessage.text === "正在调用 Codex runtime...") assistantMessage.text = "";
        assistantMessage.text += chunk;
        renderMessages();
        saveActiveConversation();
      },
      onDone(data) {
        assistantMessage.text = payload.dryRun
          ? data.result?.text || `已生成编排请求：\n\n${data.request?.message || ""}`
          : extractAgentResponse(data);
        renderMessages();
        saveActiveConversation();
      },
    });
  } catch (error) {
    state.messages.push({ role: "assistant", text: `执行失败：${error.message}` });
    await saveActiveConversation();
  }
  renderMessages();
}

async function streamProjectExecution(projectId, payload, handlers = {}) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/execute/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stripEmpty(payload)),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    throw new Error(data.error || data.message || `请求失败：${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const event = parseSseEvent(part);
      if (!event) continue;
      if (event.type === "prepared") handlers.onPrepared?.(event);
      else if (event.type === "stdout") handlers.onChunk?.(event.text, event);
      else if (event.type === "stderr") handlers.onStatus?.(event.text, event);
      else if (event.type === "done") handlers.onDone?.(event);
      else if (event.type === "error") throw new Error(event.error || "执行失败");
    }
  }
}

function parseSseEvent(part) {
  const line = part.split("\n").find((item) => item.startsWith("data: "));
  if (!line) return null;
  return JSON.parse(line.slice(6));
}

function resizeComposer(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

async function uploadTextToProject(event) {
  event.preventDefault();
  const project = getActiveProject();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  const relativeDir = String(form.get("relativeDir") || "").trim();
  await submitJson("/api/knowledge/text", {
    relativeDir,
    title: form.get("title"),
    textContent: form.get("textContent"),
    metadata: project ? { projectId: project.id } : {},
  });
  formNode.reset();
  await Promise.allSettled([loadProjects(), loadKnowledge()]);
  toast("文档已入库到系统知识库。");
}

function openProjectForm(project = undefined) {
  const form = document.getElementById("projectForm");
  const active = project || null;
  showDrawerForm("project");
  form.reset();
  if (active) {
    form.elements.id.value = active.id;
    form.elements.name.value = active.name || "";
    form.elements.description.value = active.description || "";
  } else {
    form.elements.id.value = "";
  }
  renderProjectAgentPicker(active?.agentIds || []);
  renderProjectKnowledgeTree(active?.knowledgeDrawerRefs || []);
  setDrawerOpen(true);
}

function openAgentForm(agent = undefined) {
  const form = document.getElementById("agentForm");
  showDrawerForm("agent");
  renderAgentList();
  form.reset();
  if (agent) {
    form.elements.id.value = agent.id;
    form.elements.name.value = agent.name || "";
    form.elements.description.value = agent.description || "";
    form.elements.systemPrompt.value = agent.systemPrompt || "";
    form.elements.skills.value = (agent.skills || []).map(formatSkillLine).join("\n");
    form.elements.mcpServers.value = (agent.mcpServers || []).join("\n");
    form.elements.runtimeId.value = agent.runtimeId || "codex";
    form.elements.ragDocumentNames.value = (agent.explicitRagDocumentNames || []).join("\n");
    form.elements.defaultMode.value = agent.defaultMode || "query";
    form.elements.topN.value = agent.topN || 4;
  } else {
    form.elements.id.value = "";
    form.elements.runtimeId.value = "codex";
    form.elements.defaultMode.value = "query";
    form.elements.topN.value = 4;
  }
  setDrawerOpen(true);
}

function showDrawerForm(type) {
  document.getElementById("projectForm").classList.toggle("hidden", type !== "project");
  document.getElementById("agentForm").classList.toggle("hidden", type !== "agent");
  document.getElementById("agentListSection").classList.toggle("hidden", type !== "agent");
  document.getElementById("drawerTitle").textContent = type === "agent" ? "Agent 配置" : "项目";
  document.getElementById("drawerSubtitle").textContent = type === "agent"
    ? "创建全局 Agent：预置提示词、Skill、MCP 和 runtime。"
    : "创建或编辑 project、可用 Agent 和知识抽屉授权。";
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
    text: `MCP 端点：http://localhost:${state.status?.wrapper?.port || 8787}/mcp\n\n系统工具以 hippo_ 开头，包括 hippo_list_projects、hippo_create_project、hippo_project_rag_search、hippo_execute_project_task。`,
  });
  renderMessages();
  saveActiveConversation();
}

function showRuntimeMessage() {
  const status = state.status;
  state.messages.push({
    role: "assistant",
    text: status
      ? `Wrapper :${status.wrapper.port}\nRuntime：${status.wrapper.settings?.defaultRuntimeId || "codex"}\nRAG：${status.wrapper.settings?.ragProviderId || "anythingllm"}\n认证：${status.anythingllm.auth?.authenticated ? "已认证" : "未认证"}`
      : "运行状态尚未加载。",
  });
  renderMessages();
  saveActiveConversation();
}

async function createConversationForActiveProject() {
  const project = getActiveProject();
  if (!project) {
    state.messages = [];
    renderActiveProject();
    renderMessages();
    return;
  }
  const { conversation } = await submitJson(`/api/projects/${encodeURIComponent(project.id)}/conversations`, {
    title: "新对话",
    messages: [],
  }, false);
  state.activeConversationId = conversation.id;
  await loadConversations(project.id);
  renderActiveProject();
}

function getActiveProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

function getActiveConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeConversationId) || null;
}

async function ensureActiveConversation(task = "") {
  const project = getActiveProject();
  if (!project) throw new Error("请先创建项目。");
  const existing = getActiveConversation();
  if (existing) return existing;
  const { conversation } = await submitJson(`/api/projects/${encodeURIComponent(project.id)}/conversations`, {
    title: deriveConversationTitle(task),
    messages: [],
  }, false);
  state.activeConversationId = conversation.id;
  await loadConversations(project.id);
  return conversation;
}

async function saveActiveConversation() {
  const project = getActiveProject();
  const conversation = getActiveConversation();
  if (!project || !conversation) return;
  const title = deriveConversationTitleFromMessages(state.messages) || conversation.title || "新对话";
  const { conversation: updated } = await request(
    `/api/projects/${encodeURIComponent(project.id)}/conversations/${encodeURIComponent(conversation.id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, messages: state.messages }),
    }
  );
  state.conversations = [updated].concat(state.conversations.filter((item) => item.id !== updated.id));
  state.activeConversationId = updated.id;
  renderProjectList();
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

function deriveConversationTitle(task) {
  const compact = String(task || "").trim().replace(/\s+/g, " ");
  if (!compact) return "新对话";
  return compact.length > 28 ? `${compact.slice(0, 28)}...` : compact;
}

function deriveConversationTitleFromMessages(messages) {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.text?.trim());
  return firstUserMessage ? deriveConversationTitle(firstUserMessage.text) : "";
}

function formatConversationTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return "刚刚";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} 天`;
  return `${Math.floor(days / 7)} 周`;
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

function renderKnowledgeNode(item, selected, depth, primaryOnly = false) {
  const primaryPath = item.path.split("/")[0];
  const checked = selected.has(primaryPath) ? "checked" : "";
  const indent = depth * 14;
  const count = item.type === "folder" ? countKnowledgeDocs(item) : item.documentNames?.length || 0;
  const childItems = Array.isArray(item.children) ? item.children : [];
  const children = childItems.length && !primaryOnly
    ? `<div class="knowledgeChildren">${childItems.map((child) => renderKnowledgeNode(child, selected, depth + 1, primaryOnly)).join("")}</div>`
    : "";
  const isSelectable = item.type === "folder" && (!primaryOnly || depth === 0);
  return `
    <label class="knowledgeNode ${item.type}" style="--depth:${indent}px">
      ${isSelectable ? `<input name="knowledgeDrawerRefs" type="checkbox" value="${escapeHtml(primaryPath)}" ${checked} />` : ""}
      <span>${item.type === "folder" ? "▸" : "·"}</span>
      <strong>${escapeHtml(item.name)}</strong>
      <small>${count} 文档</small>
    </label>
    ${children}
  `;
}

function countKnowledgeDocs(item) {
  if (item.type === "file") return item.documentNames?.length || 0;
  const children = Array.isArray(item.children) ? item.children : [];
  return children.reduce((sum, child) => sum + countKnowledgeDocs(child), 0);
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
