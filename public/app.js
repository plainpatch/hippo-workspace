const state = {
  projects: [],
  agents: [],
  knowledge: null,
  status: null,
  activeProjectId: null,
  activeConversationId: null,
  conversations: [],
  collapsedProjectIds: new Set(),
  selectedKnowledgePath: "",
  workspaceKnowledgeSelection: {
    drawers: new Set(),
    topics: new Set(),
  },
  currentView: "chat",
  activeRun: null,
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
  document.getElementById("projectHomeBtn").addEventListener("click", renderActiveProject);
  document.getElementById("searchBtn")?.addEventListener("click", () => toast("搜索入口已预留。"));
  document.getElementById("agentsBtn").addEventListener("click", showAgentsPage);
  document.getElementById("knowledgeBtn").addEventListener("click", showKnowledgePage);
  document.getElementById("inboxBtn")?.addEventListener("click", showInboxPage);
  document.getElementById("mcpBtn").addEventListener("click", showMcpMessage);
  document.getElementById("runtimeBtn").addEventListener("click", showRuntimeMessage);
  document.getElementById("settingsBtn").addEventListener("click", showSettingsPage);
  document.getElementById("createProjectBtn").addEventListener("click", () => openProjectForm());
  document.getElementById("projectConfigBtn").addEventListener("click", () => {
    if (state.currentView === "agents") openAgentForm();
    else if (state.currentView === "knowledge") focusKnowledgeCreateAction();
    else if (state.currentView === "inbox") showInboxPage();
    else if (state.currentView === "settings") refreshSettingsPage();
    else if (state.currentView === "run-detail") renderActiveProject();
    else openProjectForm(getActiveProject());
  });
  document.getElementById("closeDrawerBtn").addEventListener("click", closeDrawer);
  document.getElementById("attachTextBtn").addEventListener("click", openDrawer);

  document.getElementById("projectForm").addEventListener("submit", saveProject);
  document.getElementById("projectKnowledgeFilter")?.addEventListener("input", () => {
    const active = getActiveProject();
    renderProjectKnowledgeTreeFromForm(active);
  });
  document.getElementById("agentForm").addEventListener("submit", saveAgent);
  document.getElementById("agentTypeSelect")?.addEventListener("change", syncAgentTypeFields);
  document.getElementById("addDagNodeBtn")?.addEventListener("click", addDagNodeFromBuilder);
  document.getElementById("addDagEdgeBtn")?.addEventListener("click", addDagEdgeFromBuilder);
  document.getElementById("syncDagJsonBtn")?.addEventListener("click", renderDagBuilderFromJson);
  document.getElementById("composerForm").addEventListener("submit", sendMessage);
  document.getElementById("contextStrategySelect")?.addEventListener("change", syncContextStrategyFields);
  document.getElementById("stopExecutionBtn")?.addEventListener("click", cancelActiveRun);
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
  const data = await request("/api/workspaces");
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
  if (state.currentView === "chat") renderActiveProject();
}

async function loadConversations(projectId) {
  const data = await request(`/api/workspaces/${encodeURIComponent(projectId)}/conversations`);
  state.conversations = data.conversations || [];
  if (state.activeConversationId && !state.conversations.some((item) => item.id === state.activeConversationId)) {
    state.activeConversationId = null;
  }
  if (!state.activeConversationId && state.conversations.length) {
    state.activeConversationId = state.conversations[0].id;
  }
  const active = getActiveConversation();
  state.messages = active?.messages ? [...active.messages] : [];
  await refreshMessageRunSummaries(projectId);
  renderProjectList();
}

async function refreshMessageRunSummaries(projectId) {
  const runIds = [...new Set((state.messages || []).map((message) => message.runId).filter(Boolean))];
  if (!runIds.length) return;
  try {
    const data = await request(`/api/workspaces/${encodeURIComponent(projectId)}/runs`);
    const runsById = new Map((data.runs || []).map((run) => [run.id, run]));
    state.messages = state.messages.map((message) => {
      const run = runsById.get(message.runId);
      return run ? { ...message, agentRunSummary: summarizeAgentRun(run) } : message;
    });
  } catch {
    // Run summaries are best-effort UI state; keep messages usable if the run list is unavailable.
  }
}

async function loadAgents() {
  const data = await request("/api/agents");
  state.agents = data.agents || [];
  renderAgentOptions();
}

async function loadKnowledge() {
  const data = await request("/api/knowledge");
  state.knowledge = data;
  renderProjectKnowledgeTreeFromForm(getActiveProject());
  if (state.currentView === "knowledge") renderKnowledgeManager();
}

function renderProjectList() {
  const target = document.getElementById("projectList");
  if (!state.projects.length) {
    target.innerHTML = `
      <div class="emptyBlock">还没有工作区。</div>
      <button class="emptyCreateProject" data-empty-create-project type="button">新建工作区</button>
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
        <button class="projectOptionsButton" data-project-options-id="${escapeHtml(project.id)}" type="button" aria-label="工作区设置">${icons.options}</button>
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
  setActiveSystemNav("chat");
  document.getElementById("composerForm").classList.remove("hidden");
  renderAgentOptions();
  const project = getActiveProject();
  const name = document.getElementById("activeProjectName");
  const meta = document.getElementById("activeProjectMeta");
  const configButton = document.getElementById("projectConfigBtn");
  const input = document.getElementById("messageInput");
  setHeaderConfigButton(true);

  if (!project) {
    name.textContent = "选择或创建工作区";
    meta.textContent = "左侧工作区由 App 管理；Agent 和知识库都是全局定义后被工作区引用。";
    configButton.textContent = "新建工作区";
    input.disabled = true;
    input.placeholder = "请先创建工作区";
    if (!state.messages.length) {
      state.messages = [{
        role: "assistant",
        text: "先在左侧创建一个工作区。工作区管理本地目录、可用 Agent 和知识库引用。",
      }];
      renderMessages();
    }
    return;
  }

  name.textContent = project.name;
  meta.textContent = `${project.localWorkspaceFolderName || project.id} · ${state.conversations.length} 个会话 · ${project.knowledgeDrawerRefs?.length || 0} 个知识库 · ${project.knowledgeTopicRefs?.length || 0} 个主题筛选 · ${project.agentIds?.length || 0} 个 Agent`;
  configButton.textContent = "工作区设置";
  input.disabled = false;
  input.placeholder = `向「${project.name}」提问；可选加载 Agent`;
  if (!state.messages.length) {
    state.messages = [{
      role: "assistant",
      text: `当前工作区本地目录为「${project.localWorkspacePath || "未记录"}」。对话使用 Codex runtime；AnythingLLM 只作为 RAG provider。`,
    }];
  }
  renderMessages();
}

function renderMessages() {
  const stream = document.getElementById("chatStream");
  stream.innerHTML = state.messages.map((message) => `
    <article class="message ${escapeHtml(message.role)}">
      <div class="messageAvatar">${message.role === "user" ? "你" : "H"}</div>
      <div class="messageBody">
        <div class="messageMeta">${message.role === "user" ? "你" : "Hippo Agent"}</div>
        <div class="messageText">${formatMessage(message.text)}</div>
        ${message.agentRunSummary ? renderAgentRunSummary(message.agentRunSummary, message.runId) : ""}
      </div>
    </article>
  `).join("");
  stream.querySelectorAll("[data-run-detail-id]").forEach((button) => {
    button.addEventListener("click", () => showRunDetail(button.dataset.runDetailId));
  });
  stream.scrollTop = stream.scrollHeight;
}

function showAgentsPage() {
  state.currentView = "agents";
  setActiveSystemNav("agents");
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(true);
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
      <small>${agent.type === "dag" ? `DAG · ${(agent.nodes || []).length} 节点` : "单节点"} · v${agent.version || 1} · ${(agent.skills || []).length} Skill · ${agent.runtimeId || "codex"}</small>
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

function showKnowledgePage() {
  state.currentView = "knowledge";
  setActiveSystemNav("knowledge");
  closeDrawer();
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(true);
  document.getElementById("activeProjectName").textContent = "知识库";
  document.getElementById("activeProjectMeta").textContent = "系统路径 knowledge 下的两级目录：一级知识库表示领域类型，二级主题表示领域下的细分知识类型。";
  document.getElementById("projectConfigBtn").textContent = "新建主题";
  renderKnowledgeManager();
}

async function showInboxPage() {
  state.currentView = "inbox";
  setActiveSystemNav("inbox");
  closeDrawer();
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(true);
  document.getElementById("activeProjectName").textContent = "待处理";
  document.getElementById("activeProjectMeta").textContent = "等待人工输入的 DAG 节点；提交输出后会继续推进运行图。";
  document.getElementById("projectConfigBtn").textContent = "刷新";
  await renderInboxManager();
}

function showSettingsPage() {
  state.currentView = "settings";
  setActiveSystemNav("");
  closeDrawer();
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(false);
  document.getElementById("activeProjectName").textContent = "系统设置";
  document.getElementById("activeProjectMeta").textContent = "配置 APP 系统路径、runtime 和 RAG provider。部分设置保存后需要重启生效。";
  const settings = state.status?.wrapper?.settings || {};
  const codex = settings.runtimes?.codex || {};
  const anythingllm = settings.ragProviders?.anythingllm || {};
  const stream = document.getElementById("chatStream");
  stream.innerHTML = `
    <section class="settingsPanel">
      <form id="appSettingsForm" class="settingsForm">
        <div class="settingsSection">
          <h2>系统路径</h2>
          <label>资源根目录
            <input name="resourceRootPath" value="${escapeHtml(settings.resourceRootPath || settings.appHomePath || "")}" />
          </label>
          <small>保存后重启生效；工作区和知识库目录会基于这个路径。</small>
        </div>
        <div class="settingsSection">
          <h2>Runtime</h2>
          <label>默认 Runtime
            <select name="defaultRuntimeId">
              <option value="codex" ${settings.defaultRuntimeId === "codex" ? "selected" : ""}>Codex</option>
            </select>
          </label>
          <label>Codex Command
            <input name="codexCommand" value="${escapeHtml(codex.command || "codex")}" />
          </label>
          <label>Codex Model
            <input name="codexModel" value="${escapeHtml(codex.model || "")}" placeholder="可选" />
          </label>
          <label>Sandbox
            <select name="codexSandboxMode">
              ${["workspace-write", "read-only", "danger-full-access"].map((item) =>
                `<option value="${item}" ${codex.sandboxMode === item ? "selected" : ""}>${item}</option>`
              ).join("")}
            </select>
          </label>
          <label>Service Tier
            <input name="codexServiceTier" value="${escapeHtml(codex.serviceTier || "fast")}" />
          </label>
        </div>
        <div class="settingsSection">
          <h2>RAG Provider</h2>
          <label>默认 RAG Provider
            <select name="ragProviderId">
              <option value="anythingllm" ${settings.ragProviderId === "anythingllm" ? "selected" : ""}>AnythingLLM</option>
            </select>
          </label>
          <label>AnythingLLM URL
            <input name="anythingllmBaseUrl" value="${escapeHtml(anythingllm.baseUrl || "")}" />
          </label>
          <small>RAG provider URL 保存后需要重启服务才能重新初始化客户端。</small>
        </div>
        <button class="primary" type="submit">保存设置</button>
      </form>
    </section>
  `;
  document.getElementById("appSettingsForm")?.addEventListener("submit", saveAppSettings);
  stream.scrollTop = 0;
}

async function refreshSettingsPage() {
  await checkStatus();
  showSettingsPage();
}

async function saveAppSettings(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await request("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stripEmpty(Object.fromEntries(form.entries()))),
  });
  state.status = {
    ...(state.status || {}),
    wrapper: {
      ...(state.status?.wrapper || {}),
      settings: result.settings,
    },
  };
  toast(settingsRestartText(result.requiresRestart));
  showSettingsPage();
}

async function renderInboxManager() {
  const stream = document.getElementById("chatStream");
  const project = getActiveProject();
  if (!project) {
    stream.innerHTML = `<div class="emptyBlock">请先选择工作区。</div>`;
    return;
  }
  const data = await request(`/api/workspaces/${encodeURIComponent(project.id)}/runs`);
  const waitingItems = (data.runs || []).flatMap((run) =>
    Object.values(run.nodeRuns || {})
      .filter((node) => node.status === "waiting")
      .map((node) => ({ run, node }))
  );
  stream.innerHTML = `
    <section class="inboxPage">
      ${waitingItems.length ? waitingItems.map(({ run, node }) => renderInboxItem(run, node)).join("") : `<div class="emptyBlock">当前工作区没有等待处理的节点。</div>`}
    </section>
  `;
  stream.querySelectorAll("[data-resume-form]").forEach((form) => {
    form.addEventListener("submit", resumeWaitingNode);
  });
  stream.scrollTop = 0;
}

async function showRunDetail(runId) {
  const project = getActiveProject();
  if (!project || !runId) return;
  const [runData, traceData] = await Promise.all([
    request(`/api/workspaces/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(runId)}`),
    request(`/api/workspaces/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(runId)}/trace`),
  ]);
  const run = runData.run;
  state.currentView = "run-detail";
  setActiveSystemNav("chat");
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(true);
  document.getElementById("projectConfigBtn").textContent = "返回对话";
  document.getElementById("activeProjectName").textContent = "运行详情";
  document.getElementById("activeProjectMeta").textContent = `${project.name} · ${run.id}`;
  const stream = document.getElementById("chatStream");
  stream.innerHTML = renderRunDetail(run, traceData.trace || []);
  stream.scrollTop = 0;
}

function renderRunDetail(run, trace = []) {
  const nodes = Object.values(run.nodeRuns || {});
  return `
    <section class="runDetailPage">
      <div class="runDetailHeader">
        <div>
          <h2>${escapeHtml(run.agentSnapshot?.name || "通用助手")}</h2>
          <small>${escapeHtml(run.id)} · ${escapeHtml(run.status)}</small>
        </div>
        <span class="runStatus ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
      </div>
      <dl class="runDetailGrid">
        <dt>工作区</dt><dd>${escapeHtml(run.workspaceId || "")}</dd>
        <dt>Root Session</dt><dd>${escapeHtml(run.rootSessionId || "")}</dd>
        <dt>Agent</dt><dd>${escapeHtml(run.agentId || "通用助手")} · v${escapeHtml(run.agentVersion || 1)}</dd>
        <dt>Runtime</dt><dd>${escapeHtml(run.request?.runtimeId || "codex")}</dd>
        <dt>Sandbox</dt><dd>${escapeHtml(run.request?.runtimeOptions?.sandboxMode || "默认")}</dd>
        <dt>上下文</dt><dd>${escapeHtml(run.request?.contextPolicy?.strategy || "runtime")}</dd>
      </dl>
      <div class="runDetailSection">
        <h3>节点</h3>
        <div class="runDetailNodes">
          ${nodes.map(renderRunDetailNode).join("") || `<div class="emptyBlock">没有节点。</div>`}
        </div>
      </div>
      <div class="runDetailSection">
        <h3>Trace</h3>
        <div class="traceList">
          ${trace.slice(-80).map(renderTraceEvent).join("") || `<div class="emptyBlock">没有 trace。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderRunDetailNode(node) {
  return `
    <div class="runDetailNode ${escapeHtml(node.status || "pending")}">
      <div>
        <strong>${escapeHtml(node.nodeId || "root")}</strong>
        <small>${escapeHtml(node.kind || "task")} · ${escapeHtml(node.id || "")}</small>
      </div>
      <span class="runStatus ${escapeHtml(node.status || "pending")}">${escapeHtml(node.status || "pending")}</span>
      <dl>
        <dt>Runtime Run</dt><dd>${escapeHtml(node.runtimeRunId || "")}</dd>
        <dt>Runtime Session</dt><dd>${escapeHtml(node.runtimeSession?.sessionId || "")}</dd>
        <dt>Sandbox</dt><dd>${escapeHtml(node.runtimeSession?.runtimeOptions?.sandboxMode || "")}</dd>
        <dt>输出</dt><dd>${escapeHtml(summarizeRunOutput(node.output) || "")}</dd>
      </dl>
    </div>
  `;
}

function renderTraceEvent(event) {
  const payload = event.payload === undefined ? "" : JSON.stringify(event.payload);
  return `
    <div class="traceItem">
      <strong>${escapeHtml(event.type || "trace")}</strong>
      <small>${escapeHtml(event.createdAt || "")}</small>
      ${payload ? `<code>${escapeHtml(payload.length > 360 ? `${payload.slice(0, 360)}...` : payload)}</code>` : ""}
    </div>
  `;
}

function renderInboxItem(run, node) {
  const nodeDef = (run.agentSnapshot?.nodes || []).find((item) => item.id === node.nodeId) || {};
  return `
    <form class="inboxItem" data-resume-form data-run-id="${escapeHtml(run.id)}" data-node-run-id="${escapeHtml(node.id)}">
      <div class="inboxItemHeader">
        <div>
          <strong>${escapeHtml(nodeDef.name || node.nodeId)}</strong>
          <small>${escapeHtml(run.agentSnapshot?.name || "DAG Run")} · ${escapeHtml(run.id.slice(0, 8))}</small>
        </div>
        <span class="runStatus waiting">waiting</span>
      </div>
      ${nodeDef.description ? `<p>${escapeHtml(nodeDef.description)}</p>` : ""}
      <textarea name="output" rows="4" placeholder="填写人工确认结果或补充信息，支持 JSON"></textarea>
      <div class="inboxActions">
        <button class="primary" type="submit">继续运行</button>
      </div>
    </form>
  `;
}

async function resumeWaitingNode(event) {
  event.preventDefault();
  const project = getActiveProject();
  const form = event.currentTarget;
  const rawOutput = new FormData(form).get("output");
  await request(`/api/workspaces/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(form.dataset.runId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeRunId: form.dataset.nodeRunId,
      output: parseLooseJson(rawOutput),
    }),
  });
  toast("等待节点已继续。");
  await loadConversations(project.id);
  await saveActiveConversation();
  await renderInboxManager();
}

function focusKnowledgeCreateAction() {
  const selected = state.selectedKnowledgePath;
  if (selected?.includes("/")) {
    state.selectedKnowledgePath = selected.split("/")[0];
    renderKnowledgeManager();
  }
  document.querySelector("#knowledgeTopicForm input[name='name']")?.focus();
  if (!document.querySelector("#knowledgeTopicForm input[name='name']")) {
    document.getElementById("knowledgeDomainForm")?.classList.remove("hidden");
    document.getElementById("knowledgeDomainName")?.focus();
  }
}

function renderKnowledgeManager() {
  const stream = document.getElementById("chatStream");
  const tree = state.knowledge?.tree;
  const domains = Array.isArray(tree?.children)
    ? tree.children.filter((item) => item.type === "folder")
    : [];
  const selectedNode = findKnowledgeNode(state.selectedKnowledgePath, domains) || domains[0] || null;
  state.selectedKnowledgePath = selectedNode?.path || "";
  stream.innerHTML = `
    <section class="knowledgeManager">
      <aside class="knowledgeTreePane">
        <div class="knowledgeTreeHeader">
          <h2>知识库</h2>
          <button id="newKnowledgeDomainBtn" type="button">新建</button>
        </div>
        <form id="knowledgeDomainForm" class="knowledgeQuickForm hidden">
          <label>领域类型 <input id="knowledgeDomainName" name="name" required placeholder="例如：网关平台" /></label>
          <label>描述 <textarea name="description" rows="3" required placeholder="说明这个领域覆盖的文档范围"></textarea></label>
          <button class="primary" type="submit">创建知识库</button>
        </form>
        <div class="knowledgeTreeList">
          ${domains.length ? domains.map((domain) => renderKnowledgeTreeItem(domain, selectedNode?.path || "")).join("") : `<div class="emptyBlock">还没有知识库。</div>`}
        </div>
      </aside>
      <section class="knowledgeDetailPane">
        ${selectedNode ? renderKnowledgeDetail(selectedNode, domains) : renderEmptyKnowledgeDetail()}
      </section>
    </section>
  `;
  document.getElementById("knowledgeDomainForm")?.addEventListener("submit", saveKnowledgeDomain);
  document.getElementById("newKnowledgeDomainBtn")?.addEventListener("click", () => {
    document.getElementById("knowledgeDomainForm")?.classList.toggle("hidden");
    document.getElementById("knowledgeDomainName")?.focus();
  });
  document.getElementById("knowledgeTopicForm")?.addEventListener("submit", saveKnowledgeTopic);
  stream.querySelectorAll("[data-knowledge-meta-path]").forEach((form) => {
    form.addEventListener("submit", saveKnowledgeMetadata);
  });
  stream.querySelectorAll("[data-knowledge-node-path]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedKnowledgePath = button.dataset.knowledgeNodePath;
      renderKnowledgeManager();
    });
  });
  stream.scrollTop = 0;
}

function renderKnowledgeTreeItem(domain, selectedPath) {
  const topics = getKnowledgeTopics(domain);
  const isActive = domain.path === selectedPath;
  return `
    <div class="knowledgeTreeGroup">
      <button class="knowledgeTreeNode domain ${isActive ? "active" : ""}" data-knowledge-node-path="${escapeHtml(domain.path)}" type="button">
        <span>▾</span>
        <strong>${escapeHtml(domain.title || domain.name)}</strong>
        <small>${topics.length}</small>
      </button>
      <div class="knowledgeTreeChildren">
        ${topics.map((topic) => `
          <button class="knowledgeTreeNode topic ${topic.path === selectedPath ? "active" : ""}" data-knowledge-node-path="${escapeHtml(topic.path)}" type="button">
            <span></span>
            <strong>${escapeHtml(topic.title || topic.name)}</strong>
            <small>${countKnowledgeDocs(topic)}</small>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function renderKnowledgeDetail(node, domains) {
  const isDomain = node.level === 1;
  const topics = isDomain ? getKnowledgeTopics(node) : [];
  const documents = collectKnowledgeDocuments(node);
  return `
    <div class="knowledgeDetailHeader">
      <div>
        <span>${isDomain ? "一级知识库" : "二级主题"}</span>
        <h2>${escapeHtml(node.title || node.name)}</h2>
      </div>
      <small>${node.path}</small>
    </div>
    ${renderKnowledgeMetadataForm(node, `${isDomain ? `${topics.length} 主题 · ` : ""}${documents.length} 文档`)}
    ${isDomain ? renderKnowledgeTopicCreator(node) : ""}
    <div class="knowledgeDetailSection">
      <h3>${isDomain ? "目录列表" : "文档列表"}</h3>
      ${isDomain ? renderKnowledgeTopicDirectory(topics) : renderKnowledgeDocumentList(documents)}
    </div>
    <div class="knowledgeDetailSection">
      <h3>相关配置</h3>
      <dl class="knowledgeConfigList">
        <dt>路径</dt><dd>${escapeHtml(node.path)}</dd>
        <dt>层级</dt><dd>${isDomain ? "一级知识库 / 领域类型" : "二级主题 / 细分知识类型"}</dd>
        <dt>工作区引用</dt><dd>${isDomain ? "工作区引用此一级知识库后，检索包含其下主题。" : "二级主题可在工作区设置中勾选为检索筛选项。"}</dd>
        <dt>文档数</dt><dd>${documents.length}</dd>
      </dl>
    </div>
  `;
}

function renderEmptyKnowledgeDetail() {
  return `
    <div class="knowledgeEmptyDetail">
      <h2>还没有知识库</h2>
      <p>在左侧新建一级知识库，再为其添加二级主题。</p>
    </div>
  `;
}

function renderKnowledgeTopicCreator(domain) {
  return `
    <form id="knowledgeTopicForm" class="knowledgeInlineForm">
      <input name="domainPath" type="hidden" value="${escapeHtml(domain.path)}" />
      <label>新建主题 <input name="name" required placeholder="例如：部署运维" /></label>
      <label>描述 <textarea name="description" rows="2" required placeholder="说明这个主题下应放哪些资料"></textarea></label>
      <button class="primary" type="submit">创建主题</button>
    </form>
  `;
}

function renderKnowledgeTopicDirectory(topics) {
  if (!topics.length) return `<div class="knowledgeTopicEmpty">还没有二级主题。</div>`;
  return `
    <div class="knowledgeDirectoryList">
      ${topics.map((topic) => `
        <button class="knowledgeDirectoryItem" data-knowledge-node-path="${escapeHtml(topic.path)}" type="button">
          <strong>${escapeHtml(topic.title || topic.name)}</strong>
          <span>${escapeHtml(topic.description || "未填写描述")}</span>
          <small>${countKnowledgeDocs(topic)} 文档</small>
        </button>
      `).join("")}
    </div>
  `;
}

function renderKnowledgeDocumentList(documents) {
  if (!documents.length) return `<div class="knowledgeTopicEmpty">暂无文档。</div>`;
  return `
    <div class="knowledgeDirectoryList">
      ${documents.map((doc) => `
        <div class="knowledgeDirectoryItem static">
          <strong>${escapeHtml(doc.name)}</strong>
          <span>${escapeHtml(doc.path)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderKnowledgeMetadataForm(item, summary) {
  const typeLabel = item.level === 1 ? "一级知识库" : "二级主题";
  const title = item.title || item.name;
  return `
    <form class="knowledgeMetaForm" data-knowledge-meta-path="${escapeHtml(item.path)}">
      <div class="knowledgeMetaHeader">
        <strong>${escapeHtml(`${typeLabel} · ${title}`)}</strong>
        <small>${escapeHtml(summary)}</small>
      </div>
      <div class="knowledgeMetaFields">
        <label>名称 <input name="name" required value="${escapeHtml(title)}" /></label>
        <label>描述 <textarea name="description" rows="2" required>${escapeHtml(item.description || "")}</textarea></label>
        <button type="submit">保存</button>
      </div>
    </form>
  `;
}

function findKnowledgeNode(pathValue, domains) {
  if (!pathValue) return null;
  for (const domain of domains) {
    if (domain.path === pathValue) return domain;
    const topic = getKnowledgeTopics(domain).find((item) => item.path === pathValue);
    if (topic) return topic;
  }
  return null;
}

function getKnowledgeTopics(domain) {
  return Array.isArray(domain?.children) ? domain.children.filter((item) => item.type === "folder") : [];
}

function collectKnowledgeDocuments(item) {
  if (!item) return [];
  if (item.type === "file") return [item];
  const children = Array.isArray(item.children) ? item.children : [];
  return children.flatMap(collectKnowledgeDocuments);
}

async function saveKnowledgeDomain(event) {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  await submitJson("/api/knowledge/domains", {
    name: form.get("name"),
    description: form.get("description"),
  }, false);
  formNode.reset();
  state.knowledge = await request("/api/knowledge");
  renderProjectKnowledgeTree([]);
  renderKnowledgeManager();
  toast("知识库已创建。");
}

async function saveKnowledgeTopic(event) {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  await submitJson("/api/knowledge/topics", {
    domainPath: form.get("domainPath"),
    name: form.get("name"),
    description: form.get("description"),
  }, false);
  formNode.reset();
  state.knowledge = await request("/api/knowledge");
  renderProjectKnowledgeTree([]);
  renderKnowledgeManager();
  toast("主题已创建。");
}

async function saveKnowledgeMetadata(event) {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  await request("/api/knowledge/folders", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      drawerPath: formNode.dataset.knowledgeMetaPath,
      name: form.get("name"),
      description: form.get("description"),
    }),
  });
  state.knowledge = await request("/api/knowledge");
  renderProjectKnowledgeTree([]);
  renderKnowledgeManager();
  toast("知识库元信息已保存。");
}

function setActiveSystemNav(view) {
  document.querySelectorAll("[data-system-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.systemView === view);
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

function renderProjectKnowledgeTree(selectedRefs = [], selectedTopicRefs = []) {
  const target = document.getElementById("projectKnowledgeTree");
  if (!target) return;
  const tree = state.knowledge?.tree;
  const filterValue = document.getElementById("projectKnowledgeFilter")?.value || "";
  const children = filterProjectKnowledgeItems(Array.isArray(tree?.children) ? tree.children : [], filterValue);
  if (!children.length) {
    target.innerHTML = filterValue
      ? `<div class="emptyBlock">没有匹配的知识库或主题。</div>`
      : `<div class="emptyBlock">系统知识库暂无内容。可先在下方入库文本，或通过 API 上传文件。</div>`;
    return;
  }
  const selected = new Set(selectedRefs || []);
  const selectedTopics = new Set(selectedTopicRefs || []);
  target.innerHTML = children.map((item) => renderKnowledgeNode(item, selected, selectedTopics, 0)).join("");
  target.querySelectorAll("[name='knowledgeDrawerRefs'], [name='knowledgeTopicRefs']").forEach((input) => {
    input.addEventListener("change", () => {
      const collection = input.name === "knowledgeTopicRefs"
        ? state.workspaceKnowledgeSelection.topics
        : state.workspaceKnowledgeSelection.drawers;
      if (input.checked) collection.add(input.value);
      else collection.delete(input.value);
      if (input.name === "knowledgeTopicRefs" && input.checked) {
        state.workspaceKnowledgeSelection.drawers.add(input.value.split("/")[0]);
      }
      renderProjectKnowledgeTreeFromForm(getActiveProject(), { preserveDomSelection: false });
    });
  });
}

function renderProjectKnowledgeTreeFromForm(project = undefined, options = {}) {
  if (options.preserveDomSelection !== false) captureWorkspaceKnowledgeSelection();
  if (!state.workspaceKnowledgeSelection.drawers.size && project?.knowledgeDrawerRefs?.length) {
    state.workspaceKnowledgeSelection.drawers = new Set(project.knowledgeDrawerRefs || []);
  }
  if (!state.workspaceKnowledgeSelection.topics.size && project?.knowledgeTopicRefs?.length) {
    state.workspaceKnowledgeSelection.topics = new Set(project.knowledgeTopicRefs || []);
  }
  renderProjectKnowledgeTree(
    [...state.workspaceKnowledgeSelection.drawers],
    [...state.workspaceKnowledgeSelection.topics]
  );
}

function captureWorkspaceKnowledgeSelection() {
  const form = document.getElementById("projectForm");
  if (!form) return;
  form.querySelectorAll("[name='knowledgeDrawerRefs'], [name='knowledgeTopicRefs']").forEach((input) => {
    const collection = input.name === "knowledgeTopicRefs"
      ? state.workspaceKnowledgeSelection.topics
      : state.workspaceKnowledgeSelection.drawers;
    if (input.checked) collection.add(input.value);
    else collection.delete(input.value);
  });
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
  captureWorkspaceKnowledgeSelection();
  const selectedTopicRefs = [...state.workspaceKnowledgeSelection.topics];
  const selectedDrawerRefs = [...state.workspaceKnowledgeSelection.drawers];
  const body = {
    name: form.get("name"),
    description: form.get("description"),
    agentIds: [...formNode.querySelectorAll("[name='agentIds']:checked")].map((item) => item.value),
    knowledgeDrawerRefs: [...new Set([
      ...selectedDrawerRefs,
      ...selectedTopicRefs.map((item) => item.split("/")[0]).filter(Boolean),
    ])],
    knowledgeTopicRefs: selectedTopicRefs,
  };

  const result = id
    ? await request(`/api/workspaces/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stripEmpty(body)),
      })
    : await submitJson("/api/workspaces", body, false);

  state.activeProjectId = result.project.id;
  state.activeConversationId = null;
  state.conversations = [];
  state.messages = [];
  await loadProjects();
  closeDrawer();
  toast("工作区已保存。");
}

async function saveAgent(event) {
  event.preventDefault();
  const formNode = event.currentTarget;
  const form = new FormData(formNode);
  const id = form.get("id");
  const type = form.get("type") || "single";
  const body = {
    type,
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
  if (type === "dag") {
    body.rootNodeId = String(form.get("rootNodeId") || "").trim();
    body.nodes = parseJsonField(form.get("nodesJson"), []);
    body.edges = parseJsonField(form.get("edgesJson"), []);
    body.executionPolicy = { concurrency: Number(form.get("dagConcurrency") || 4) };
  }

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
  const runId = crypto.randomUUID?.() || `run-${Date.now()}`;
  const payload = {
    task,
    agentId: form.get("agentId") || undefined,
    mode: form.get("mode") || undefined,
    sessionId: conversation.id,
    runId,
    dryRun: Boolean(form.get("dryRun")),
    contextStrategy: form.get("contextStrategy") || "runtime",
    contextSummary: form.get("contextStrategy") === "manual-summary"
      ? String(form.get("contextSummary") || "").trim()
      : "",
    sandboxMode: form.get("sandboxMode") || undefined,
  };
  const turnMetadata = buildTurnMetadata(project, conversation, payload);
  state.messages.push({ role: "user", text: task, runId, metadata: { ...turnMetadata, messageRole: "user" } });
  renderMessages();
  await saveActiveConversation();
  const input = document.getElementById("messageInput");
  input.value = "";
  resizeComposer(input);

  try {
    const assistantMessage = {
      role: "assistant",
      text: "正在准备执行...",
      runId,
      metadata: { ...turnMetadata, messageRole: "assistant", status: "preparing" },
    };
    state.messages.push(assistantMessage);
    renderMessages();
    setActiveRun(project.id, payload.runId);
    await streamProjectExecution(project.id, payload, {
      onPrepared(event) {
        setActiveRun(project.id, event.request?.runId || payload.runId);
        assistantMessage.runId = event.request?.runId || payload.runId;
        assistantMessage.metadata = mergeMessageMetadata(assistantMessage.metadata, {
          runId: assistantMessage.runId,
          agentId: event.agent?.id || payload.agentId || "",
          agentName: event.agent?.name || "",
          runtimeId: event.request?.runtimeId || turnMetadata.runtimeId,
          contextPolicy: event.request?.contextPolicy,
          sandboxMode: event.request?.runtimeOptions?.sandboxMode || turnMetadata.sandboxMode || "",
          status: payload.dryRun ? "dry-run" : "running",
        });
        if (event.agentRun) assistantMessage.agentRunSummary = summarizeAgentRun(event.agentRun);
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
        assistantMessage.runId = data.agentRun?.id || assistantMessage.runId || payload.runId;
        if (data.agentRun) assistantMessage.agentRunSummary = summarizeAgentRun(data.agentRun);
        assistantMessage.metadata = mergeMessageMetadata(assistantMessage.metadata, {
          runId: assistantMessage.runId,
          status: data.agentRun?.status || "completed",
          runtimeSession: data.result?.runtimeSession,
          runtimeId: data.result?.runtimeId || data.request?.runtimeId || assistantMessage.metadata?.runtimeId,
          sandboxMode: data.result?.runtimeSession?.runtimeOptions?.sandboxMode || data.request?.runtimeOptions?.sandboxMode || assistantMessage.metadata?.sandboxMode || "",
          agentRunId: data.agentRun?.id || "",
          agentRunStatus: data.agentRun?.status || "",
        });
        clearActiveRun();
        renderMessages();
        saveActiveConversation();
      },
      onDagNodeEvent(event) {
        assistantMessage.agentRunSummary = updateRunSummaryNode(assistantMessage.agentRunSummary, event);
        renderMessages();
      },
      onRuntimeEvent(event) {
        if (event.eventType === "runtime_session_started") setActiveRun(project.id, event.runId || payload.runId);
      },
      onCancelled(event) {
        assistantMessage.text = `${assistantMessage.text || ""}\n\n运行已停止。`.trim();
        assistantMessage.metadata = mergeMessageMetadata(assistantMessage.metadata, {
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
          cancelEvent: event,
        });
        clearActiveRun();
        renderMessages();
        saveActiveConversation();
      },
    });
  } catch (error) {
    clearActiveRun();
    state.messages.push({
      role: "assistant",
      text: `执行失败：${error.message}`,
      runId,
      metadata: { ...turnMetadata, messageRole: "assistant", status: "failed", error: error.message },
    });
    await saveActiveConversation();
  }
  renderMessages();
}

function syncContextStrategyFields() {
  const strategy = document.getElementById("contextStrategySelect")?.value || "runtime";
  const summary = document.getElementById("contextSummaryInput");
  if (!summary) return;
  summary.classList.toggle("hidden", strategy !== "manual-summary");
  if (strategy === "manual-summary") summary.focus();
  else summary.value = "";
}

function buildTurnMetadata(project, conversation, payload) {
  const agent = payload.agentId ? state.agents.find((item) => item.id === payload.agentId) : null;
  return stripEmpty({
    workspaceId: project.id,
    workspaceName: project.name,
    conversationId: conversation.id,
    runId: payload.runId,
    agentId: payload.agentId || "",
    agentName: agent?.name || "",
    runtimeId: agent?.runtimeId || state.status?.wrapper?.settings?.defaultRuntimeId || "codex",
    mode: payload.mode || agent?.defaultMode || "automatic",
    contextStrategy: payload.contextStrategy || "runtime",
    contextSummary: payload.contextSummary || "",
    contextSummaryProvided: Boolean(payload.contextSummary),
    sandboxMode: payload.sandboxMode || state.status?.wrapper?.settings?.runtimes?.codex?.sandboxMode || "",
    dryRun: Boolean(payload.dryRun),
    createdAt: new Date().toISOString(),
  });
}

function mergeMessageMetadata(current = {}, next = {}) {
  return stripEmpty({
    ...(current || {}),
    ...(next || {}),
    updatedAt: new Date().toISOString(),
  });
}

async function streamProjectExecution(projectId, payload, handlers = {}) {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(projectId)}/execute/stream`, {
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
      else if (event.type === "runtime_event") handlers.onRuntimeEvent?.(event);
      else if (event.type === "dag_node_started" || event.type === "dag_node_completed" || event.type === "dag_node_waiting") handlers.onDagNodeEvent?.(event);
      else if (event.type === "cancelled") handlers.onCancelled?.(event);
      else if (event.type === "done") handlers.onDone?.(event);
      else if (event.type === "error") throw new Error(event.error || "执行失败");
    }
  }
}

async function cancelActiveRun() {
  if (!state.activeRun?.runId) return;
  const current = state.activeRun;
  await request(`/api/workspaces/${encodeURIComponent(current.projectId)}/runs/${encodeURIComponent(current.runId)}/cancel`, {
    method: "POST",
  });
  toast("已请求停止当前运行。");
}

function setActiveRun(projectId, runId) {
  state.activeRun = { projectId, runId };
  document.getElementById("stopExecutionBtn")?.classList.remove("hidden");
}

function clearActiveRun() {
  state.activeRun = null;
  document.getElementById("stopExecutionBtn")?.classList.add("hidden");
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
  state.workspaceKnowledgeSelection = {
    drawers: new Set(active?.knowledgeDrawerRefs || []),
    topics: new Set(active?.knowledgeTopicRefs || []),
  };
  document.getElementById("projectKnowledgeFilter").value = "";
  renderProjectKnowledgeTree(active?.knowledgeDrawerRefs || [], active?.knowledgeTopicRefs || []);
  setDrawerOpen(true);
}

function openAgentForm(agent = undefined) {
  const form = document.getElementById("agentForm");
  showDrawerForm("agent");
  renderAgentList();
  form.reset();
  if (agent) {
    form.elements.id.value = agent.id;
    form.elements.type.value = agent.type || "single";
    form.elements.name.value = agent.name || "";
    form.elements.description.value = agent.description || "";
    form.elements.systemPrompt.value = agent.systemPrompt || "";
    form.elements.skills.value = (agent.skills || []).map(formatSkillLine).join("\n");
    form.elements.mcpServers.value = (agent.mcpServers || []).join("\n");
    form.elements.runtimeId.value = agent.runtimeId || "codex";
    form.elements.ragDocumentNames.value = (agent.explicitRagDocumentNames || []).join("\n");
    form.elements.defaultMode.value = agent.defaultMode || "query";
    form.elements.topN.value = agent.topN || 4;
    form.elements.rootNodeId.value = agent.rootNodeId || "";
    form.elements.dagConcurrency.value = agent.executionPolicy?.concurrency || 4;
    form.elements.nodesJson.value = agent.nodes?.length ? JSON.stringify(agent.nodes, null, 2) : "";
    form.elements.edgesJson.value = agent.edges?.length ? JSON.stringify(agent.edges, null, 2) : "";
  } else {
    form.elements.id.value = "";
    form.elements.type.value = "single";
    form.elements.runtimeId.value = "codex";
    form.elements.defaultMode.value = "query";
    form.elements.topN.value = 4;
    form.elements.dagConcurrency.value = 4;
    form.elements.rootNodeId.value = "";
    form.elements.nodesJson.value = "";
    form.elements.edgesJson.value = "";
  }
  syncAgentTypeFields();
  setDrawerOpen(true);
}

function syncAgentTypeFields() {
  const type = document.getElementById("agentTypeSelect")?.value || "single";
  document.getElementById("agentDagFields")?.classList.toggle("hidden", type !== "dag");
  if (type === "dag") renderDagBuilderFromJson();
}

function renderDagBuilderFromJson() {
  const form = document.getElementById("agentForm");
  if (!form || form.elements.type.value !== "dag") return;
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  renderDagBuilder(nodes, edges);
}

function renderDagBuilder(nodes = [], edges = []) {
  const preview = document.getElementById("dagGraphPreview");
  const fromSelect = document.getElementById("dagEdgeFromInput");
  const toSelect = document.getElementById("dagEdgeToInput");
  if (!preview || !fromSelect || !toSelect) return;
  const options = nodes.map((node) => `<option value="${escapeHtml(node.id)}">${escapeHtml(node.id)}</option>`).join("");
  fromSelect.innerHTML = options;
  toSelect.innerHTML = options;
  preview.innerHTML = `
    <div class="dagPreviewSection">
      <strong>节点</strong>
      ${nodes.length ? nodes.map((node) => `
        <div class="dagPreviewRow">
          <span>${escapeHtml(node.id)} · ${escapeHtml(node.kind || "task")}</span>
          <button type="button" data-remove-dag-node="${escapeHtml(node.id)}">删除</button>
        </div>
      `).join("") : `<small>还没有节点。</small>`}
    </div>
    <div class="dagPreviewSection">
      <strong>连边</strong>
      ${edges.length ? edges.map((edge, index) => `
        <div class="dagPreviewRow">
          <span>${escapeHtml(edge.from)} -> ${escapeHtml(edge.to)} · ${escapeHtml(edge.type || "serial")}${edge.required === false ? " · optional" : ""}</span>
          <button type="button" data-remove-dag-edge="${index}">删除</button>
        </div>
      `).join("") : `<small>还没有连边。</small>`}
    </div>
  `;
  preview.querySelectorAll("[data-remove-dag-node]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextNodes = nodes.filter((node) => node.id !== button.dataset.removeDagNode);
      const nextEdges = edges.filter((edge) => edge.from !== button.dataset.removeDagNode && edge.to !== button.dataset.removeDagNode);
      setDagJson(nextNodes, nextEdges);
    });
  });
  preview.querySelectorAll("[data-remove-dag-edge]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.removeDagEdge);
      setDagJson(nodes, edges.filter((_, itemIndex) => itemIndex !== index));
    });
  });
}

function addDagNodeFromBuilder() {
  const form = document.getElementById("agentForm");
  const nodeId = document.getElementById("dagNodeIdInput").value.trim();
  if (!nodeId) return toast("请填写节点 ID。", true);
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  if (nodes.some((node) => node.id === nodeId)) return toast("节点 ID 已存在。", true);
  const node = {
    id: nodeId,
    kind: document.getElementById("dagNodeKindInput").value || "task",
    name: document.getElementById("dagNodeNameInput").value.trim() || nodeId,
  };
  setDagJson([...nodes, node], edges);
  if (!form.elements.rootNodeId.value) form.elements.rootNodeId.value = nodeId;
  document.getElementById("dagNodeIdInput").value = "";
  document.getElementById("dagNodeNameInput").value = "";
}

function addDagEdgeFromBuilder() {
  const form = document.getElementById("agentForm");
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  const from = document.getElementById("dagEdgeFromInput").value;
  const to = document.getElementById("dagEdgeToInput").value;
  if (!from || !to) return toast("请先添加节点。", true);
  if (from === to) return toast("连边不能指向同一个节点。", true);
  const edge = {
    from,
    to,
    type: document.getElementById("dagEdgeTypeInput").value || "serial",
    required: document.getElementById("dagEdgeRequiredInput").checked,
  };
  setDagJson(nodes, [...edges, edge]);
}

function setDagJson(nodes, edges) {
  const form = document.getElementById("agentForm");
  form.elements.nodesJson.value = JSON.stringify(nodes, null, 2);
  form.elements.edgesJson.value = JSON.stringify(edges, null, 2);
  renderDagBuilder(nodes, edges);
}

function showDrawerForm(type) {
  document.getElementById("projectForm").classList.toggle("hidden", type !== "project");
  document.getElementById("agentForm").classList.toggle("hidden", type !== "agent");
  document.getElementById("agentListSection").classList.toggle("hidden", type !== "agent");
  document.getElementById("drawerTitle").textContent = type === "agent" ? "Agent 配置" : "工作区设置";
  document.getElementById("drawerSubtitle").textContent = type === "agent"
    ? "创建全局 Agent：预置提示词、Skill、MCP 和 runtime。"
    : "创建或编辑工作区、可用 Agent 和知识库引用。";
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
    text: `MCP 端点：http://localhost:${state.status?.wrapper?.port || 8787}/mcp\n\n工作区工具包括 hippo_list_workspaces、hippo_create_workspace、hippo_workspace_rag_search、hippo_execute_workspace_task。`,
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
  const { conversation } = await submitJson(`/api/workspaces/${encodeURIComponent(project.id)}/conversations`, {
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
  if (!project) throw new Error("请先创建工作区。");
  const existing = getActiveConversation();
  if (existing) return existing;
  const { conversation } = await submitJson(`/api/workspaces/${encodeURIComponent(project.id)}/conversations`, {
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
    `/api/workspaces/${encodeURIComponent(project.id)}/conversations/${encodeURIComponent(conversation.id)}`,
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

function summarizeAgentRun(run) {
  const nodes = Object.values(run?.nodeRuns || {}).map((node) => ({
    id: node.id,
    nodeId: node.nodeId,
    kind: node.kind || "task",
    status: node.status,
    runtimeSessionId: node.runtimeSession?.sessionId || "",
    text: summarizeRunOutput(node.output),
  }));
  return {
    id: run?.id || "",
    status: run?.status || "pending",
    agentType: run?.agentSnapshot?.type || "single",
    agentName: run?.agentSnapshot?.name || "",
    nodes,
  };
}

function summarizeRunOutput(output) {
  if (!output) return "";
  if (typeof output.text === "string") return output.text.slice(0, 160);
  if (typeof output === "string") return output.slice(0, 160);
  return "";
}

function updateRunSummaryNode(summary, event) {
  if (!summary) {
    summary = { id: event.runId || "", status: "running", agentType: "dag", nodes: [] };
  }
  const nodes = Array.isArray(summary.nodes) ? [...summary.nodes] : [];
  const index = nodes.findIndex((node) => node.id === event.nodeRunId || node.nodeId === event.nodeId);
  const current = index === -1 ? { id: event.nodeRunId, nodeId: event.nodeId } : nodes[index];
  const updated = {
    ...current,
    id: event.nodeRunId || current.id,
    nodeId: event.nodeId || current.nodeId,
    status: event.type === "dag_node_completed" ? "completed" : event.type === "dag_node_waiting" ? "waiting" : "running",
    runtimeSessionId: event.result?.runtimeSession?.sessionId || current.runtimeSessionId || "",
    text: event.result ? summarizeRunOutput(event.result) : current.text || "",
  };
  if (index === -1) nodes.push(updated);
  else nodes[index] = updated;
  return {
    ...summary,
    status: nodes.some((node) => node.status === "waiting")
      ? "waiting"
      : event.type === "dag_node_completed" && nodes.every((node) => node.status === "completed")
        ? "completed"
        : "running",
    nodes,
  };
}

function renderAgentRunSummary(summary, messageRunId = "") {
  const nodes = Array.isArray(summary.nodes) ? summary.nodes : [];
  const runId = summary.id || messageRunId;
  return `
    <div class="runSummary">
      <div class="runSummaryHeader">
        <strong>${escapeHtml(summary.agentType === "dag" ? "DAG Run" : "Run")}</strong>
        <div class="runSummaryActions">
          <span class="runStatus ${escapeHtml(summary.status || "pending")}">${escapeHtml(summary.status || "pending")}</span>
          ${runId ? `<button class="runDetailButton" data-run-detail-id="${escapeHtml(runId)}" type="button">详情</button>` : ""}
        </div>
      </div>
      ${summary.agentName ? `<small>${escapeHtml(summary.agentName)}</small>` : ""}
      <div class="runNodeList">
        ${nodes.map((node) => `
          <div class="runNode ${escapeHtml(node.status || "pending")}">
            <span>${escapeHtml(node.nodeId || "node")}${node.kind === "wait" ? " · 等待" : ""}</span>
            <small>${escapeHtml(node.status || "pending")}${node.runtimeSessionId ? ` · ${escapeHtml(node.runtimeSessionId.slice(0, 8))}` : ""}</small>
          </div>
        `).join("")}
      </div>
    </div>
  `;
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

function parseJsonField(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 格式错误：${error.message}`);
  }
}

function parseLooseJson(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatSkillLine(skill) {
  return skill.description ? `${skill.name}: ${skill.description}` : skill.name;
}

function filterProjectKnowledgeItems(items, query) {
  const needle = normalizeSearchText(query);
  if (!needle) return items;
  return items.map((domain) => {
    const topicChildren = Array.isArray(domain.children)
      ? domain.children.filter((child) => child.type === "folder")
      : [];
    const domainMatches = knowledgeSearchText(domain).includes(needle);
    const matchedTopics = topicChildren.filter((topic) => knowledgeSearchText(topic).includes(needle));
    if (!domainMatches && !matchedTopics.length) return null;
    return {
      ...domain,
      children: domainMatches ? topicChildren : matchedTopics,
    };
  }).filter(Boolean);
}

function knowledgeSearchText(item) {
  return normalizeSearchText([
    item?.title,
    item?.name,
    item?.path,
    item?.description,
  ].filter(Boolean).join(" "));
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

function renderKnowledgeNode(item, selectedDomains, selectedTopics, depth) {
  const primaryPath = item.path.split("/")[0];
  const isDomain = item.type === "folder" && depth === 0;
  const isTopic = item.type === "folder" && depth === 1;
  const checked = isDomain
    ? selectedDomains.has(primaryPath) ? "checked" : ""
    : selectedTopics.has(item.path) ? "checked" : "";
  const indent = depth * 14;
  const count = item.type === "folder" ? countKnowledgeDocs(item) : item.documentNames?.length || 0;
  const childItems = Array.isArray(item.children) ? item.children : [];
  const topicChildren = childItems.filter((child) => child.type === "folder");
  const children = topicChildren.length && depth === 0
    ? `<div class="knowledgeChildren">${topicChildren.map((child) => renderKnowledgeNode(child, selectedDomains, selectedTopics, depth + 1)).join("")}</div>`
    : "";
  const isSelectable = isDomain || isTopic;
  const inputName = isTopic ? "knowledgeTopicRefs" : "knowledgeDrawerRefs";
  const label = isTopic ? "主题" : "知识库";
  return `
    <label class="knowledgeNode ${item.type}" style="--depth:${indent}px">
      ${isSelectable ? `<input name="${inputName}" type="checkbox" value="${escapeHtml(isTopic ? item.path : primaryPath)}" ${checked} />` : ""}
      <span>${item.type === "folder" ? "▸" : "·"}</span>
      <strong>${escapeHtml(item.title || item.name)}</strong>
      <small>${label} · ${count} 文档</small>
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

function settingsRestartText(requiresRestart = {}) {
  const restartKeys = Object.entries(requiresRestart)
    .filter(([, required]) => required)
    .map(([key]) => key);
  return restartKeys.length
    ? `设置已保存；${restartKeys.join("、")} 需要重启后生效。`
    : "设置已保存。";
}

function setHeaderConfigButton(visible) {
  document.getElementById("projectConfigBtn")?.classList.toggle("hidden", !visible);
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
