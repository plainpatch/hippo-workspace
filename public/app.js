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
  selectedDagNodeId: "root",
  selectedDagEdgeKey: "",
  currentView: "chat",
  activeRun: null,
  messages: [],
};

const DAG_NODE_WIDTH = 210;
const DAG_NODE_HEIGHT = 188;
const DAG_COLUMN_GAP = 60;
const DAG_ROW_GAP = 36;

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
    else if (state.currentView === "agent-editor") submitActiveAgentEditor();
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
  state.projects = data.workspaces || data.projects || [];
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
  setChatStreamMode("");
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
  closeDrawer();
  setChatStreamMode("");
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(true);
  document.getElementById("activeProjectName").textContent = "智能体";
  document.getElementById("activeProjectMeta").textContent = "全局 Agent 原型；工作区可引用后在会话中切换使用。";
  document.getElementById("projectConfigBtn").textContent = "新建 Agent";
  const stream = document.getElementById("chatStream");
  stream.innerHTML = `
    <section class="agentHome">
      <div class="agentCards">
        <button class="agentCard agentCreateCard" id="createAgentInlineBtn" type="button">
          <strong>新增智能体</strong>
          <span>进入画布，从 Root 节点开始编排。</span>
          <small>+</small>
        </button>
      ${state.agents.length ? state.agents.map((agent) => `
        <button class="agentCard" data-agent-id="${escapeHtml(agent.id)}" type="button">
          <strong>${escapeHtml(agent.name)}</strong>
          <span>${escapeHtml(agent.description || "未填写说明")}</span>
          <small>${formatAgentCardMeta(agent)}</small>
        </button>
      `).join("") : ""}
      </div>
    </section>
  `;
  document.getElementById("createAgentInlineBtn")?.addEventListener("click", () => openAgentForm());
  stream.querySelectorAll("[data-agent-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const agent = state.agents.find((item) => item.id === button.dataset.agentId);
      if (agent) openAgentForm(agent);
    });
  });
}

function formatAgentCardMeta(agent) {
  const nodeCount = agent.type === "dag" ? Math.max(1, (agent.nodes || []).length) : 1;
  return `${nodeCount} 节点 · v${agent.version || 1} · ${agent.runtimeId || "codex"}`;
}

function showKnowledgePage() {
  state.currentView = "knowledge";
  setActiveSystemNav("knowledge");
  closeDrawer();
  setChatStreamMode("");
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
  setChatStreamMode("");
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(true);
  document.getElementById("activeProjectName").textContent = "待处理";
  document.getElementById("activeProjectMeta").textContent = "等待人工审批的 DAG 节点；确认后会继续推进运行图。";
  document.getElementById("projectConfigBtn").textContent = "刷新";
  await renderInboxManager();
}

function showSettingsPage() {
  state.currentView = "settings";
  setActiveSystemNav("");
  closeDrawer();
  setChatStreamMode("");
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
      .filter((node) => ["waiting", "waiting_approval"].includes(node.status))
      .map((node) => ({ run, node }))
  );
  stream.innerHTML = `
    <section class="inboxPage">
      ${waitingItems.length ? waitingItems.map(({ run, node }) => renderInboxItem(run, node)).join("") : `<div class="emptyBlock">当前工作区没有待审批节点。</div>`}
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
        <h3>Root 协调器</h3>
        <div class="runDetailNodes">
          ${renderRootCoordinatorDetail(run.rootCoordinator)}
        </div>
      </div>
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

function renderRootCoordinatorDetail(root = {}) {
  return `
    <div class="runDetailNode ${escapeHtml(root.status || "pending")}">
      <div>
        <strong>RootAgent</strong>
        <small>${escapeHtml(root.prototypeNodeId || "root")}</small>
      </div>
      <span class="runStatus ${escapeHtml(root.status || "pending")}">${escapeHtml(root.status || "pending")}</span>
      <dl>
        <dt>Runtime Session</dt><dd>${escapeHtml(root.runtimeSession?.sessionId || "")}</dd>
        <dt>决策次数</dt><dd>${escapeHtml(root.decisionCount || 0)}</dd>
        <dt>最后决定</dt><dd>${escapeHtml(root.lastDecision ? JSON.stringify(root.lastDecision) : "")}</dd>
      </dl>
    </div>
  `;
}

function renderRunDetailNode(node) {
  return `
    <div class="runDetailNode ${escapeHtml(node.status || "pending")}">
      <div>
        <strong>${escapeHtml(node.prototypeNodeId || node.nodeId || "root")} · 第 ${escapeHtml(node.attempt || 1)} 次</strong>
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
  toast("审批已提交，节点已继续。");
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
  stream.querySelectorAll("[data-sync-topic-path]").forEach((button) => {
    button.addEventListener("click", () => syncKnowledgeTopic(button.dataset.syncTopicPath, button));
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
      <div class="knowledgeDetailActions">
        <small>${escapeHtml(node.path)}</small>
        ${isDomain ? "" : `<button data-sync-topic-path="${escapeHtml(node.path)}" type="button">同步 RAG</button>`}
      </div>
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
        ${isDomain ? "" : `
          <dt>RAG Workspace</dt><dd>${escapeHtml(node.rag?.workspaceSlug || "未创建")}</dd>
          <dt>RAG 状态</dt><dd>${escapeHtml(node.rag?.status || "pending")}</dd>
          <dt>最近同步</dt><dd>${escapeHtml(node.rag?.syncedAt || "未同步")}</dd>
        `}
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
          ${doc.documentNames?.length ? `<small>${escapeHtml(doc.documentNames.length)} RAG 文档</small>` : ""}
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

async function syncKnowledgeTopic(topicPath, button) {
  if (!topicPath) return;
  const original = button?.textContent || "同步 RAG";
  if (button) {
    button.disabled = true;
    button.textContent = "同步中";
  }
  try {
    const result = await request("/api/knowledge/topics/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicPath }),
    });
    state.knowledge = await request("/api/knowledge");
    renderKnowledgeManager();
    toast(`同步完成：扫描 ${result.scanned || 0} 个，更新 ${result.synced?.length || 0} 个。`);
  } catch (error) {
    toast(`同步失败：${error.message}`);
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
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

  state.activeProjectId = (result.workspace || result.project).id;
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
  const nodes = ensureRootDraft({
    nodes: parseJsonField(form.get("nodesJson"), []),
    edges: parseJsonField(form.get("edgesJson"), []),
  }).nodes;
  const edges = ensureRootDraft({
    nodes,
    edges: parseJsonField(form.get("edgesJson"), []),
  }).edges;
  const rootNode = nodes.find((node) => node.id === "root") || {};
  const type = nodes.length > 1 || edges.length ? "dag" : "single";
  const body = {
    type,
    name: form.get("name"),
    description: form.get("description"),
    systemPrompt: rootNode.systemPrompt || form.get("systemPrompt"),
    skills: parseSkills(form.get("skills")),
    mcpServers: splitLinesOrComma(form.get("mcpServers")),
    runtimeId: form.get("runtimeId") || "codex",
    ragDocumentNames: splitLinesOrComma(form.get("ragDocumentNames")),
    rag: normalizeNodeRag(rootNode.rag),
  };
  if (type === "dag") {
    body.rootNodeId = "root";
    body.nodes = nodes;
    body.edges = edges;
    body.executionPolicy = { maxDecisions: Number(form.get("maxDecisions") || 50) };
    validateDagDraft(body);
  }

  id
    ? await request(`/api/agents/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stripEmpty(body)),
      })
    : await submitJson("/api/agents", body, false);

  await loadAgents();
  showAgentsPage();
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
  closeDrawer();
  state.currentView = "agent-editor";
  setActiveSystemNav("agents");
  setChatStreamMode("agentEditorStream");
  document.getElementById("composerForm").classList.add("hidden");
  setHeaderConfigButton(true);
  document.getElementById("activeProjectName").textContent = agent ? `编辑智能体：${agent.name}` : "新增智能体";
  document.getElementById("activeProjectMeta").textContent = "在画布中从 Root 节点开始编排；只有 Root 时会保存为单节点 Agent。";
  document.getElementById("projectConfigBtn").textContent = "保存";

  const draft = createAgentDraft(agent);
  state.selectedDagNodeId = "root";
  state.selectedDagEdgeKey = "";
  const stream = document.getElementById("chatStream");
  stream.innerHTML = renderAgentEditor(draft);
  bindAgentEditorEvents();
  renderDagBuilder(draft.nodes, draft.edges);
  stream.scrollTop = 0;
}

function setChatStreamMode(mode) {
  const stream = document.getElementById("chatStream");
  stream.classList.toggle("agentEditorStream", mode === "agentEditorStream");
}

function createAgentDraft(agent = undefined) {
  const nodes = agent?.type === "dag" ? [...(agent.nodes || [])] : [];
  const edges = agent?.type === "dag" ? [...(agent.edges || [])] : [];
  return ensureRootDraft({
    id: agent?.id || "",
    name: agent?.name || "",
    description: agent?.description || "",
    systemPrompt: agent?.systemPrompt || "",
    skills: (agent?.skills || []).map(formatSkillLine).join("\n"),
    mcpServers: (agent?.mcpServers || []).join("\n"),
    runtimeId: agent?.runtimeId || "codex",
    ragDocumentNames: (agent?.explicitRagDocumentNames || agent?.ragDocumentNames || []).join("\n"),
    rag: normalizeNodeRag(agent?.rag),
    maxDecisions: agent?.executionPolicy?.maxDecisions || 50,
    nodes,
    edges,
    previousRootNodeId: agent?.rootNodeId || nodes[0]?.id || "",
  });
}

function ensureRootDraft(draft) {
  const rootNode = {
    id: "root",
    kind: "task",
    runtimeApprovalPolicy: "inherit",
    resultApprovalPolicy: "none",
    transitionInstruction: "",
    rag: normalizeNodeRag(draft.rag),
    name: "Root",
    description: "智能体入口节点，负责接收用户任务并调度后续节点。",
    systemPrompt: draft.systemPrompt || "",
  };
  let nodes = Array.isArray(draft.nodes) ? draft.nodes.filter((node) => node?.id) : [];
  let edges = Array.isArray(draft.edges) ? draft.edges.filter((edge) => edge?.from && edge?.to) : [];
  const existingRoot = nodes.find((node) => node.id === "root");
  if (existingRoot) {
    nodes = nodes.map((node) => node.id === "root" ? { ...rootNode, ...node, id: "root" } : node);
  } else {
    const previousRoot = draft.previousRootNodeId && draft.previousRootNodeId !== "root" ? draft.previousRootNodeId : nodes[0]?.id;
    nodes = [rootNode, ...nodes];
    if (previousRoot && !edges.some((edge) => edge.from === "root" && edge.to === previousRoot)) {
      edges = [{ from: "root", to: previousRoot }, ...edges];
    }
  }
  return { ...draft, nodes, edges };
}

function renderAgentEditor(draft) {
  return `
    <form id="agentForm" class="agentEditor">
      <input name="id" type="hidden" value="${escapeHtml(draft.id)}" />
      <input name="type" type="hidden" value="dag" />
      <input name="rootNodeId" type="hidden" value="root" />
      <input name="maxDecisions" type="hidden" value="${escapeHtml(draft.maxDecisions)}" />
      <textarea name="nodesJson" class="hidden">${escapeHtml(JSON.stringify(draft.nodes, null, 2))}</textarea>
      <textarea name="edgesJson" class="hidden">${escapeHtml(JSON.stringify(draft.edges, null, 2))}</textarea>
      <textarea name="systemPrompt" class="hidden">${escapeHtml(draft.systemPrompt)}</textarea>
      <textarea name="skills" class="hidden">${escapeHtml(draft.skills)}</textarea>
      <textarea name="mcpServers" class="hidden">${escapeHtml(draft.mcpServers)}</textarea>
      <textarea name="ragDocumentNames" class="hidden">${escapeHtml(draft.ragDocumentNames)}</textarea>

      <div class="agentEditorMeta">
        <label>名称 <input name="name" required placeholder="例如：文档审查 Agent" value="${escapeHtml(draft.name)}" /></label>
        <label>说明 <input name="description" placeholder="这个 Agent 擅长什么任务" value="${escapeHtml(draft.description)}" /></label>
        <label>Runtime
          <select name="runtimeId">
            <option value="codex" ${draft.runtimeId === "codex" ? "selected" : ""}>Codex</option>
          </select>
        </label>
      </div>

      <div class="agentCanvasLayout">
        <div class="dagCanvasShell">
          <div id="dagGraphPreview" class="dagGraphPreview"></div>
        </div>
        <aside class="dagInspector">
          <div class="dagInspectorHeader">
            <strong>节点配置</strong>
            <button id="removeDagNodeBtn" type="button">删除节点</button>
          </div>
          <label>节点 ID <input id="dagNodeIdInput" readonly /></label>
          <label>节点名称 <input id="dagNodeNameInput" placeholder="需求分析" /></label>
          <label>执行命令审批
            <select id="dagNodeRuntimeApprovalInput">
              <option value="inherit">继承会话设置</option>
              <option value="untrusted">仅信任命令免审</option>
              <option value="on-request">按需请求审批</option>
              <option value="never">不请求审批</option>
            </select>
          </label>
          <label id="dagNodeResultApprovalField">完成结果审核
            <select id="dagNodeResultApprovalInput">
              <option value="none">免审</option>
              <option value="manual">人工审批</option>
              <option value="auto">自动审批</option>
            </select>
          </label>
          <label class="dagNodeRagToggle"><input id="dagNodeRagEnabledInput" type="checkbox" /> 启用 RAG 工具</label>
          <label id="dagNodeRagTopNField">RAG Top N <input id="dagNodeRagTopNInput" type="number" min="1" value="4" /></label>
          <div class="dagEdgeEditor">
            <div class="dagEdgeEditorHeader">
              <strong>节点连接</strong>
              <small id="dagConnectionCount"></small>
            </div>
            <div id="dagConnectionSummary" class="dagConnectionSummary"></div>
          </div>
          <label>接口描述 <textarea id="dagNodeDescriptionInput" rows="2" placeholder="说明该节点对 RootAgent 暴露的能力、适用场景和输出"></textarea></label>
          <label>系统提示词 <textarea id="dagNodePromptInput" rows="3" placeholder="该节点执行任务时使用的系统提示词"></textarea></label>
          <label>结果处置规则 <textarea id="dagNodeTransitionInput" rows="3" placeholder="RootAgent 收到该节点结果后，如何继续、重试、请求用户或结束任务"></textarea></label>
        </aside>
      </div>

      <div class="agentCanvasConsole">
        <button id="addDagNodeBtn" type="button">新增节点</button>
        <button id="removeDagEdgeBtn" type="button" disabled>删除连线</button>
        <button id="importAgentGraphBtn" type="button">导入</button>
        <button id="alignDagCanvasBtn" type="button">对齐</button>
        <button id="saveAgentCanvasBtn" class="primary" type="submit">保存</button>
        <input id="agentGraphImportInput" class="hidden" type="file" accept="application/json,.json" />
      </div>
    </form>
  `;
}

function bindAgentEditorEvents() {
  document.getElementById("agentForm")?.addEventListener("submit", saveAgent);
  document.getElementById("addDagNodeBtn")?.addEventListener("click", addDagNodeFromBuilder);
  document.getElementById("removeDagNodeBtn")?.addEventListener("click", removeSelectedDagNode);
  document.getElementById("removeDagEdgeBtn")?.addEventListener("click", removeSelectedDagEdge);
  document.getElementById("alignDagCanvasBtn")?.addEventListener("click", alignDagCanvas);
  document.getElementById("importAgentGraphBtn")?.addEventListener("click", () => document.getElementById("agentGraphImportInput")?.click());
  document.getElementById("agentGraphImportInput")?.addEventListener("change", importAgentGraphFile);
  ["dagNodeNameInput", "dagNodeRuntimeApprovalInput", "dagNodeResultApprovalInput", "dagNodeRagEnabledInput", "dagNodeRagTopNInput", "dagNodeDescriptionInput", "dagNodePromptInput", "dagNodeTransitionInput"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", updateSelectedDagNodeFromInspector);
  });
}

function submitActiveAgentEditor() {
  document.getElementById("agentForm")?.requestSubmit();
}

function renderDagBuilder(nodes = [], edges = []) {
  const preview = document.getElementById("dagGraphPreview");
  if (!preview) return;
  nodes = ensureRootDraft({ nodes, edges }).nodes;
  edges = ensureRootDraft({ nodes, edges }).edges;
  const rootId = "root";
  if (!state.selectedDagNodeId || !nodes.some((node) => node.id === state.selectedDagNodeId)) {
    state.selectedDagNodeId = rootId;
  }
  if (state.selectedDagEdgeKey && !edges.some((edge) => dagEdgeKey(edge) === state.selectedDagEdgeKey)) {
    state.selectedDagEdgeKey = "";
  }
  const edgeByTarget = groupEdgesByTarget(edges);
  const edgeBySource = groupEdgesBySource(edges);
  const layout = layoutDagNodes(nodes, edges, rootId);
  const width = Math.max(760, ...Object.values(layout).map((item) => item.x + DAG_NODE_WIDTH + 40), 760);
  const height = Math.max(430, ...Object.values(layout).map((item) => item.y + DAG_NODE_HEIGHT + 40), 430);
  preview.innerHTML = `
    <svg class="dagEdgeLayer" viewBox="0 0 ${width} ${height}" aria-label="节点连线">
      <defs>
        <marker id="dagArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#7c83ff"></path>
        </marker>
      </defs>
      ${edges.map((edge) => renderDagEdgePath(edge, layout)).join("")}
      <path id="dagPendingEdge" class="dagEdgePath pending hidden"></path>
    </svg>
    <div class="dagCanvas" aria-label="DAG 可视化画布" style="width:${width}px;height:${height}px">
      ${nodes.length ? nodes.map((node) => `
        <div class="dagCanvasNode ${node.id === rootId ? "root" : ""} ${node.id === state.selectedDagNodeId ? "selected" : ""}" style="left:${layout[node.id]?.x || 24}px;top:${layout[node.id]?.y || 24}px" data-select-dag-node="${escapeHtml(node.id)}" role="button" tabindex="0">
          <span class="dagPort input ${node.id === rootId ? "disabled" : ""}" data-dag-input="${escapeHtml(node.id)}" title="输入端点"></span>
          <div class="dagNodeHeader">
            <strong>${escapeHtml(node.name || node.id)}</strong>
            <span>${node.id === rootId ? `执行: ${formatNodeRuntimeApproval(node)} · Root` : `执行: ${formatNodeRuntimeApproval(node)} · 结果: ${formatNodeResultApproval(node)}`}</span>
          </div>
          <small>${escapeHtml(node.id)}</small>
          ${node.description ? `<p>${escapeHtml(node.description)}</p>` : ""}
          <div class="dagNodeIO">
            <span>结果处置: ${node.transitionInstruction || node.routingInstruction ? "已配置" : "默认处理"}</span>
            <span>RAG: ${normalizeNodeRag(node.rag).enabled ? `启用 · Top ${normalizeNodeRag(node.rag).topN}` : "未启用"}</span>
            <span>入: ${edgeByTarget.get(node.id)?.map((edge) => edge.from).join(", ") || (node.id === rootId ? "任务输入" : "未连接")}</span>
            <span>出: ${edgeBySource.get(node.id)?.map((edge) => edge.to).join(", ") || "终端输出"}</span>
          </div>
          <span class="dagPort output" data-dag-output="${escapeHtml(node.id)}" title="输出端点"></span>
        </div>
      `).join("") : `<small>还没有节点。</small>`}
    </div>
  `;
  const renderedLayout = measureRenderedDagLayout(preview, layout);
  const renderedWidth = Math.max(width, ...Object.values(renderedLayout).map((item) => item.x + item.width + 40));
  const renderedHeight = Math.max(height, ...Object.values(renderedLayout).map((item) => item.y + item.height + 40));
  preview.style.minWidth = `${renderedWidth}px`;
  preview.style.minHeight = `${renderedHeight}px`;
  preview.querySelector(".dagEdgeLayer")?.setAttribute("viewBox", `0 0 ${renderedWidth} ${renderedHeight}`);
  const canvas = preview.querySelector(".dagCanvas");
  if (canvas) {
    canvas.style.width = `${renderedWidth}px`;
    canvas.style.height = `${renderedHeight}px`;
  }
  updateRenderedDagEdges(preview, renderedLayout);
  preview.querySelectorAll("[data-select-dag-node]").forEach((nodeElement) => {
    bindDagNodeInteraction(nodeElement, nodes, edges, renderedLayout);
  });
  preview.querySelectorAll("[data-dag-edge]").forEach((path) => {
    path.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedDagEdgeKey = path.dataset.dagEdge;
      renderDagBuilder(nodes, edges);
      preview.focus({ preventScroll: true });
    });
  });
  preview.onclick = (event) => {
    if (event.target === preview || event.target.classList.contains("dagCanvas")) {
      state.selectedDagEdgeKey = "";
      renderDagBuilder(nodes, edges);
    }
  };
  preview.tabIndex = 0;
  preview.onkeydown = (event) => {
    if ((event.key === "Delete" || event.key === "Backspace") && state.selectedDagEdgeKey) {
      event.preventDefault();
      removeSelectedDagEdge();
    }
  };
  const selectedNode = nodes.find((node) => node.id === state.selectedDagNodeId);
  if (selectedNode) loadDagNodeIntoInspector(selectedNode);
  syncDagEdgeSelection(edges);
}

function addDagNodeFromBuilder() {
  const form = document.getElementById("agentForm");
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  const nodeId = nextDagNodeId(nodes);
  const selectedId = nodes.some((node) => node.id === state.selectedDagNodeId) ? state.selectedDagNodeId : "root";
  const currentLayout = layoutDagNodes(nodes, edges, "root");
  const selectedPosition = currentLayout[selectedId] || { x: 24, y: 28 };
  const position = findAvailableDagPosition(nodes, currentLayout, {
    x: selectedPosition.x + DAG_NODE_WIDTH + DAG_COLUMN_GAP,
    y: selectedPosition.y,
  });
  const node = {
    id: nodeId,
    kind: "task",
    runtimeApprovalPolicy: "inherit",
    resultApprovalPolicy: "none",
    transitionInstruction: "",
    rag: { enabled: false, topN: 4 },
    name: "新节点",
    description: "",
    systemPrompt: "",
    metadata: { canvasPosition: position },
  };
  const nextNodes = [...nodes, node];
  const nextEdges = selectedId && selectedId !== nodeId
    ? [...edges, { from: selectedId, to: nodeId }]
    : edges;
  state.selectedDagNodeId = nodeId;
  state.selectedDagEdgeKey = selectedId ? dagEdgeKey({ from: selectedId, to: nodeId }) : "";
  setDagJson(nextNodes, nextEdges);
}

function loadDagNodeIntoInspector(node) {
  document.getElementById("dagNodeIdInput").value = node.id || "";
  document.getElementById("dagNodeNameInput").value = node.name || "";
  document.getElementById("dagNodeRuntimeApprovalInput").value = normalizeNodeRuntimeApproval(node);
  document.getElementById("dagNodeResultApprovalInput").value = normalizeNodeResultApproval(node);
  const rag = normalizeNodeRag(node.rag);
  document.getElementById("dagNodeRagEnabledInput").checked = rag.enabled;
  document.getElementById("dagNodeRagTopNInput").value = String(rag.topN);
  document.getElementById("dagNodeResultApprovalField").classList.toggle("hidden", node.id === "root");
  document.getElementById("dagNodeDescriptionInput").value = node.description || "";
  document.getElementById("dagNodePromptInput").value = node.systemPrompt || "";
  document.getElementById("dagNodeTransitionInput").value = node.transitionInstruction || node.routingInstruction || "";
  document.getElementById("removeDagNodeBtn").disabled = node.id === "root";
  syncDagNodeRagFieldState();
  renderDagConnectionSummary(node.id || "root");
}

function syncDagNodeRagFieldState() {
  const enabled = document.getElementById("dagNodeRagEnabledInput")?.checked === true;
  document.getElementById("dagNodeRagTopNField")?.classList.toggle("hidden", !enabled);
}

function renderDagConnectionSummary(selectedNodeId) {
  const form = document.getElementById("agentForm");
  const summary = document.getElementById("dagConnectionSummary");
  const count = document.getElementById("dagConnectionCount");
  if (!form || !summary || !count) return;
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  const incoming = edges.filter((edge) => edge.to === selectedNodeId).map((edge) => edge.from);
  const outgoing = edges.filter((edge) => edge.from === selectedNodeId).map((edge) => edge.to);
  count.textContent = `${incoming.length} 入 / ${outgoing.length} 出`;
  summary.innerHTML = `
    <div><span>输入</span><strong>${escapeHtml(incoming.join(", ") || (selectedNodeId === "root" ? "会话任务" : "未连接"))}</strong></div>
    <div><span>输出</span><strong>${escapeHtml(outgoing.join(", ") || "未连接")}</strong></div>
    <small>从输出端点拖到其他节点的输入端点以创建连线。</small>
  `;
}

function bindDagNodeInteraction(nodeElement, nodes, edges, layout) {
  const nodeId = nodeElement.dataset.selectDagNode;
  const selectNode = () => {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node) return;
    state.selectedDagNodeId = node.id;
    state.selectedDagEdgeKey = "";
    renderDagBuilder(nodes, edges);
  };
  nodeElement.addEventListener("click", (event) => {
    if (event.target.closest(".dagPort") || nodeElement.dataset.dragged === "true") return;
    selectNode();
  });
  nodeElement.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectNode();
    }
  });
  nodeElement.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".dagPort")) return;
    const start = layout[nodeId];
    if (!start) return;
    const origin = { x: event.clientX, y: event.clientY };
    const liveLayout = Object.fromEntries(Object.entries(layout).map(([id, position]) => [id, { ...position }]));
    let moved = false;
    nodeElement.dataset.dragged = "false";
    nodeElement.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - origin.x;
      const dy = moveEvent.clientY - origin.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      nodeElement.dataset.dragged = "true";
      const position = {
        x: Math.max(12, Math.round(start.x + dx)),
        y: Math.max(12, Math.round(start.y + dy)),
      };
      liveLayout[nodeId] = position;
      nodeElement.style.left = `${position.x}px`;
      nodeElement.style.top = `${position.y}px`;
      updateRenderedDagEdges(nodeElement.closest(".dagGraphPreview"), liveLayout);
    };
    const end = (upEvent) => {
      nodeElement.removeEventListener("pointermove", move);
      nodeElement.removeEventListener("pointerup", end);
      nodeElement.removeEventListener("pointercancel", end);
      if (nodeElement.hasPointerCapture(upEvent.pointerId)) nodeElement.releasePointerCapture(upEvent.pointerId);
      if (!moved) return;
      const position = liveLayout[nodeId];
      const nextNodes = nodes.map((node) => node.id === nodeId ? withDagCanvasPosition(node, position) : node);
      state.selectedDagNodeId = nodeId;
      state.selectedDagEdgeKey = "";
      setDagJson(nextNodes, edges);
    };
    nodeElement.addEventListener("pointermove", move);
    nodeElement.addEventListener("pointerup", end);
    nodeElement.addEventListener("pointercancel", end);
  });
  nodeElement.querySelector("[data-dag-output]")?.addEventListener("pointerdown", (event) => {
    startDagConnection(event, nodeId, layout);
  });
}

function startDagConnection(event, sourceNodeId, layout) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const preview = event.currentTarget.closest(".dagGraphPreview");
  const pending = preview?.querySelector("#dagPendingEdge");
  const source = layout[sourceNodeId];
  if (!preview || !pending || !source) return;
  const start = dagOutputPoint(source);
  pending.classList.remove("hidden");
  const move = (moveEvent) => {
    const point = dagPointerPosition(preview, moveEvent);
    pending.setAttribute("d", dagEdgeCurve(start, point));
    preview.querySelectorAll(".dagPort.input.connectionTarget").forEach((port) => port.classList.remove("connectionTarget"));
    const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest("[data-dag-input]");
    if (target && target.dataset.dagInput !== "root" && target.dataset.dagInput !== sourceNodeId) {
      target.classList.add("connectionTarget");
    }
  };
  const end = (upEvent) => {
    const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest("[data-dag-input]");
    cleanup();
    if (target) createDagEdge(sourceNodeId, target.dataset.dagInput);
  };
  const cleanup = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", cleanup);
    pending.classList.add("hidden");
    pending.removeAttribute("d");
    preview.querySelectorAll(".dagPort.input.connectionTarget").forEach((port) => port.classList.remove("connectionTarget"));
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", cleanup);
}

function createDagEdge(from, to) {
  const form = document.getElementById("agentForm");
  if (!form || !from || !to) return;
  if (to === "root") return toast("Root 是任务入口，不能连接上游节点。", true);
  if (from === to) return toast("节点不能连接到自身。", true);
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  if (!nodes.some((node) => node.id === from) || !nodes.some((node) => node.id === to)) return;
  if (edges.some((edge) => edge.from === from && edge.to === to)) {
    state.selectedDagEdgeKey = dagEdgeKey({ from, to });
    renderDagBuilder(nodes, edges);
    return toast("连线已存在。", true);
  }
  const nextEdges = [...edges, { from, to }];
  if (wouldCreateDagCycle(nodes, nextEdges)) return toast("该连线会形成循环。", true);
  state.selectedDagNodeId = to;
  state.selectedDagEdgeKey = dagEdgeKey({ from, to });
  setDagJson(nodes, nextEdges);
}

function removeSelectedDagEdge() {
  const form = document.getElementById("agentForm");
  if (!form || !state.selectedDagEdgeKey) return;
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  const nextEdges = edges.filter((edge) => dagEdgeKey(edge) !== state.selectedDagEdgeKey);
  state.selectedDagEdgeKey = "";
  setDagJson(nodes, nextEdges);
}

function syncDagEdgeSelection(edges) {
  const selected = edges.find((edge) => dagEdgeKey(edge) === state.selectedDagEdgeKey);
  const button = document.getElementById("removeDagEdgeBtn");
  if (!button) return;
  button.disabled = !selected;
  button.textContent = selected ? `删除连线 ${selected.from} → ${selected.to}` : "删除连线";
}

function alignDagCanvas() {
  const form = document.getElementById("agentForm");
  if (!form) return;
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  const layout = autoLayoutDagNodes(nodes, edges, "root");
  setDagJson(nodes.map((node) => withDagCanvasPosition(node, layout[node.id])), edges);
}

function withDagCanvasPosition(node, position) {
  return {
    ...node,
    metadata: {
      ...(node.metadata || {}),
      canvasPosition: { x: Math.round(position.x), y: Math.round(position.y) },
    },
  };
}

function findAvailableDagPosition(nodes, layout, preferred) {
  const occupied = nodes.map((node) => layout[node.id]).filter(Boolean);
  let position = { ...preferred };
  while (occupied.some((item) => Math.abs(item.x - position.x) < DAG_NODE_WIDTH + 20 && Math.abs(item.y - position.y) < DAG_NODE_HEIGHT + 20)) {
    position.y += DAG_NODE_HEIGHT + DAG_ROW_GAP;
  }
  return position;
}

function updateSelectedDagNodeFromInspector() {
  const form = document.getElementById("agentForm");
  const nodeId = state.selectedDagNodeId || "root";
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  const nextNodes = nodes.map((node) => {
    if (node.id !== nodeId) return node;
    return stripEmpty({
      ...node,
      id: node.id,
      kind: "task",
      runtimeApprovalPolicy: document.getElementById("dagNodeRuntimeApprovalInput").value || "inherit",
      resultApprovalPolicy: document.getElementById("dagNodeResultApprovalInput").value || "none",
      rag: {
        enabled: document.getElementById("dagNodeRagEnabledInput").checked,
        topN: Math.max(1, Number(document.getElementById("dagNodeRagTopNInput").value) || 4),
      },
      transitionInstruction: document.getElementById("dagNodeTransitionInput").value.trim(),
      name: document.getElementById("dagNodeNameInput").value.trim() || (node.id === "root" ? "Root" : node.id),
      description: document.getElementById("dagNodeDescriptionInput").value.trim(),
      systemPrompt: document.getElementById("dagNodePromptInput").value.trim(),
    });
  });
  form.elements.nodesJson.value = JSON.stringify(nextNodes, null, 2);
  if (nodeId === "root") form.elements.systemPrompt.value = document.getElementById("dagNodePromptInput").value.trim();
  renderDagBuilder(nextNodes, edges);
}

function nextDagNodeId(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  let index = Math.max(2, nodes.length + 1);
  while (ids.has(`node-${index}`)) index += 1;
  return `node-${index}`;
}

function normalizeNodeResultApproval(node = {}) {
  if (["manual", "auto", "none"].includes(node.resultApprovalPolicy)) return node.resultApprovalPolicy;
  if (["manual", "auto", "none"].includes(node.approvalPolicy)) return node.approvalPolicy;
  if (["manual", "auto", "none"].includes(node.approval)) return node.approval;
  return node.kind === "wait" ? "manual" : "none";
}

function normalizeNodeRuntimeApproval(node = {}) {
  return ["untrusted", "on-request", "never"].includes(node.runtimeApprovalPolicy)
    ? node.runtimeApprovalPolicy
    : "inherit";
}

function normalizeNodeRag(value = {}) {
  return {
    enabled: value?.enabled === true,
    topN: Math.max(1, Number(value?.topN) || 4),
  };
}


function formatNodeResultApproval(node = {}) {
  const approval = normalizeNodeResultApproval(node);
  if (approval === "manual") return "人工审批";
  if (approval === "auto") return "自动审批";
  return "免审";
}

function formatNodeRuntimeApproval(node = {}) {
  const approval = normalizeNodeRuntimeApproval(node);
  if (approval === "untrusted") return "信任命令免审";
  if (approval === "on-request") return "按需审批";
  if (approval === "never") return "不请求审批";
  return "继承会话";
}

function renderDagEdgePath(edge, layout) {
  const from = layout[edge.from];
  const to = layout[edge.to];
  if (!from || !to) return "";
  const key = dagEdgeKey(edge);
  const path = dagEdgeCurve(dagOutputPoint(from), dagInputPoint(to));
  const selected = key === state.selectedDagEdgeKey ? "selected" : "";
  return `
    <path class="dagEdgePath ${selected}" d="${path}" marker-end="url(#dagArrow)" data-edge-from="${escapeHtml(edge.from)}" data-edge-to="${escapeHtml(edge.to)}"></path>
    <path class="dagEdgeHit" d="${path}" data-dag-edge="${escapeHtml(key)}" data-edge-from="${escapeHtml(edge.from)}" data-edge-to="${escapeHtml(edge.to)}"></path>
  `;
}

function layoutDagNodes(nodes, edges, rootId) {
  const layout = autoLayoutDagNodes(nodes, edges, rootId);
  for (const node of nodes) {
    const position = node.metadata?.canvasPosition;
    if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
      layout[node.id] = { x: Math.max(12, position.x), y: Math.max(12, position.y) };
    }
  }
  return layout;
}

function autoLayoutDagNodes(nodes, edges, rootId) {
  const levels = computeDagLevels(nodes, edges, rootId);
  const byLevel = new Map();
  for (const node of nodes) {
    const level = levels.get(node.id) || 0;
    byLevel.set(level, [...(byLevel.get(level) || []), node]);
  }
  const layout = {};
  for (const [level, levelNodes] of byLevel.entries()) {
    levelNodes.forEach((node, index) => {
      layout[node.id] = {
        x: 24 + level * (DAG_NODE_WIDTH + DAG_COLUMN_GAP),
        y: 28 + index * (DAG_NODE_HEIGHT + DAG_ROW_GAP),
      };
    });
  }
  return layout;
}

function updateRenderedDagEdges(preview, layout) {
  preview?.querySelectorAll("[data-edge-from][data-edge-to]").forEach((path) => {
    const from = layout[path.dataset.edgeFrom];
    const to = layout[path.dataset.edgeTo];
    if (from && to) path.setAttribute("d", dagEdgeCurve(dagOutputPoint(from), dagInputPoint(to)));
  });
}

function measureRenderedDagLayout(preview, layout) {
  const measured = Object.fromEntries(Object.entries(layout).map(([id, position]) => [id, { ...position }]));
  preview.querySelectorAll("[data-select-dag-node]").forEach((nodeElement) => {
    const nodeId = nodeElement.dataset.selectDagNode;
    if (!measured[nodeId]) return;
    measured[nodeId] = {
      ...measured[nodeId],
      width: nodeElement.offsetWidth,
      height: nodeElement.offsetHeight,
    };
  });
  return measured;
}

function dagEdgeKey(edge) {
  return `${edge.from}->${edge.to}`;
}

function dagOutputPoint(position) {
  return {
    x: position.x + (position.width || DAG_NODE_WIDTH),
    y: position.y + (position.height || DAG_NODE_HEIGHT) / 2,
  };
}

function dagInputPoint(position) {
  return { x: position.x, y: position.y + (position.height || DAG_NODE_HEIGHT) / 2 };
}

function dagPointerPosition(preview, event) {
  const rect = preview.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function dagEdgeCurve(start, end) {
  const curve = Math.max(48, Math.abs(end.x - start.x) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + curve} ${start.y}, ${end.x - curve} ${end.y}, ${end.x} ${end.y}`;
}

function computeDagLevels(nodes, edges, rootId) {
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = groupEdgesBySource(edges);
  const levels = new Map();
  const queue = [];
  const roots = rootId && ids.has(rootId)
    ? [rootId]
    : nodes.filter((node) => !(groupEdgesByTarget(edges).get(node.id) || []).length).map((node) => node.id);
  for (const id of roots) {
    levels.set(id, 0);
    queue.push(id);
  }
  while (queue.length) {
    const id = queue.shift();
    const level = levels.get(id) || 0;
    for (const edge of outgoing.get(id) || []) {
      const nextLevel = level + 1;
      if (!levels.has(edge.to) || nextLevel > levels.get(edge.to)) {
        levels.set(edge.to, nextLevel);
        queue.push(edge.to);
      }
    }
  }
  nodes.forEach((node) => {
    if (!levels.has(node.id)) levels.set(node.id, 0);
  });
  return levels;
}

function removeSelectedDagNode() {
  const form = document.getElementById("agentForm");
  const nodeId = document.getElementById("dagNodeIdInput").value.trim() || state.selectedDagNodeId;
  if (!nodeId) return toast("请先选择节点。", true);
  if (nodeId === "root") return toast("Root 节点不能删除。", true);
  const nodes = parseJsonField(form.elements.nodesJson.value, []);
  const edges = parseJsonField(form.elements.edgesJson.value, []);
  const nextNodes = nodes.filter((node) => node.id !== nodeId);
  const nextEdges = edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  state.selectedDagNodeId = "root";
  setDagJson(nextNodes, nextEdges);
}

function setDagJson(nodes, edges) {
  const form = document.getElementById("agentForm");
  const draft = ensureRootDraft({ nodes, edges });
  form.elements.rootNodeId.value = "root";
  form.elements.nodesJson.value = JSON.stringify(draft.nodes, null, 2);
  form.elements.edgesJson.value = JSON.stringify(draft.edges, null, 2);
  const root = draft.nodes.find((node) => node.id === "root");
  form.elements.systemPrompt.value = root?.systemPrompt || "";
  renderDagBuilder(draft.nodes, draft.edges);
}

function applyDevDagTemplate() {
  const form = document.getElementById("agentForm");
  const nodes = [
    {
      id: "root",
      kind: "task",
      runtimeApprovalPolicy: "inherit",
      resultApprovalPolicy: "none",
      transitionInstruction: "按默认拓扑调用需求分析节点。",
      name: "Root",
      description: "接收用户任务，输出给需求分析节点。",
      systemPrompt: "",
    },
    {
      id: "requirements",
      kind: "task",
      runtimeApprovalPolicy: "inherit",
      resultApprovalPolicy: "manual",
      transitionInstruction: "如果需求边界清晰且可以实施，继续调用 development；如果缺少关键信息，向用户请求补充。",
      name: "需求分析",
      description: "分析用户需求、澄清边界、输出可执行开发计划。",
      systemPrompt: "你负责需求分析。请输出目标、约束、验收标准和开发步骤，避免直接写代码。",
    },
    {
      id: "development",
      kind: "task",
      runtimeApprovalPolicy: "inherit",
      resultApprovalPolicy: "none",
      transitionInstruction: "实现完成后调用 qa；如果实现失败，根据错误决定重试或请求用户协调。",
      name: "开发",
      description: "根据需求分析结果实现代码变更，并说明关键实现点。",
      systemPrompt: "你负责开发实现。请基于上游需求分析输出完成代码修改，并记录影响范围。",
    },
    {
      id: "qa",
      kind: "task",
      runtimeApprovalPolicy: "inherit",
      resultApprovalPolicy: "none",
      transitionInstruction: "验证通过则完成运行；存在可修复问题时回到 development，并附上失败信息。",
      name: "QA",
      description: "验证开发结果，执行回归测试，输出问题和修复建议。",
      systemPrompt: "你负责 QA。请基于需求和开发输出执行验证，列出通过项、失败项和剩余风险。",
    },
  ];
  const edges = [
    { from: "root", to: "requirements" },
    { from: "requirements", to: "development" },
    { from: "development", to: "qa" },
  ];
  form.elements.rootNodeId.value = "root";
  form.elements.maxDecisions.value = 50;
  setDagJson(nodes, edges);
}

async function importAgentGraphFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const content = await file.text();
    const data = JSON.parse(content);
    const nodes = Array.isArray(data.nodes) ? data.nodes : Array.isArray(data.agent?.nodes) ? data.agent.nodes : [];
    const edges = Array.isArray(data.edges) ? data.edges : Array.isArray(data.agent?.edges) ? data.agent.edges : [];
    if (!nodes.length) throw new Error("JSON 中没有 nodes。");
    if (data.name && document.getElementById("agentForm")?.elements.name && !document.getElementById("agentForm").elements.name.value) {
      document.getElementById("agentForm").elements.name.value = data.name;
    }
    state.selectedDagNodeId = "root";
    setDagJson(nodes, edges);
    toast("已导入智能体画布。");
  } catch (error) {
    toast(`导入失败：${error.message}`, true);
  } finally {
    event.target.value = "";
  }
}

function validateDagDraft(body) {
  if (!body.nodes.length) throw new Error("DAG 至少需要一个节点。");
  const ids = new Set(body.nodes.map((node) => node.id));
  if (!body.rootNodeId || !ids.has(body.rootNodeId)) throw new Error("Root Node ID 必须指向已有节点。");
  for (const edge of body.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`连边 ${edge.from} -> ${edge.to} 指向不存在的节点。`);
    if (edge.from === edge.to) throw new Error("连边不能指向同一个节点。");
  }
  if (wouldCreateDagCycle(body.nodes, body.edges)) throw new Error("DAG 不能包含循环连边。");
}

function wouldCreateDagCycle(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeId) => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const next of outgoing.get(nodeId) || []) {
      if (visit(next)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

function groupEdgesByTarget(edges) {
  return edges.reduce((map, edge) => {
    map.set(edge.to, [...(map.get(edge.to) || []), edge]);
    return map;
  }, new Map());
}

function groupEdgesBySource(edges) {
  return edges.reduce((map, edge) => {
    map.set(edge.from, [...(map.get(edge.from) || []), edge]);
    return map;
  }, new Map());
}

function showDrawerForm(type) {
  document.getElementById("configDrawer")?.classList.remove("wide");
  document.getElementById("projectForm")?.classList.toggle("hidden", type !== "project");
  document.getElementById("agentForm")?.classList.toggle("hidden", type !== "agent");
  document.getElementById("agentListSection")?.classList.toggle("hidden", type !== "agent");
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
    rootCoordinator: run?.rootCoordinator ? {
      status: run.rootCoordinator.status,
      decisionCount: run.rootCoordinator.decisionCount || 0,
      runtimeSessionId: run.rootCoordinator.runtimeSession?.sessionId || "",
      lastDecision: run.rootCoordinator.lastDecision,
    } : undefined,
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
    status: event.type === "dag_node_completed" ? "completed" : event.type === "dag_node_waiting" ? "waiting_approval" : "running",
    runtimeSessionId: event.result?.runtimeSession?.sessionId || current.runtimeSessionId || "",
    text: event.result ? summarizeRunOutput(event.result) : current.text || "",
  };
  if (index === -1) nodes.push(updated);
  else nodes[index] = updated;
  return {
    ...summary,
    status: nodes.some((node) => ["waiting", "waiting_approval"].includes(node.status))
      ? "waiting_approval"
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
        ${summary.rootCoordinator ? `
          <div class="runNode ${escapeHtml(summary.rootCoordinator.status || "pending")}">
            <span>RootAgent · ${escapeHtml(summary.rootCoordinator.decisionCount || 0)} 次决策</span>
            <small>${escapeHtml(summary.rootCoordinator.status || "pending")}${summary.rootCoordinator.runtimeSessionId ? ` · ${escapeHtml(summary.rootCoordinator.runtimeSessionId.slice(0, 8))}` : ""}</small>
          </div>
        ` : ""}
        ${nodes.map((node) => `
          <div class="runNode ${escapeHtml(node.status || "pending")}">
            <span>${escapeHtml(node.nodeId || "node")}${["waiting", "waiting_approval"].includes(node.status) ? " · 待审批" : ""}</span>
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
  if (Array.isArray(value)) {
    return value
      .map(stripEmpty)
      .filter((item) => item !== undefined && item !== "");
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, stripEmpty(item)])
      .filter(([, item]) => item !== undefined && item !== "")
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
