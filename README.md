# Hippo

Hippo 是一个运行在本地的 Agent 工作台。它以 Codex 等本地 Agent Runtime 为执行基础，补充工作区、知识库、RAG 和多 Agent 编排能力，让通用编码 Agent 更适合长期、结构化的实际工作。

Hippo 不替代 Codex，也不使用 AnythingLLM 执行对话：

- **Codex** 是当前接入的 Agent Runtime，负责推理、对话、工具调用和任务执行。
- **AnythingLLM** 是当前 RAG Provider，负责文档向量化和召回。
- **Hippo** 管理工作区、会话、知识授权、Agent 蓝图和运行图，并把所需能力按配置提供给 Runtime。

项目预留了 Runtime 和 RAG Provider 适配接口。当前只完成 Codex Runtime 与 AnythingLLM RAG Provider 的接入，后续可以扩展 Claude、Hermes 或其他实现。

## 为什么做 Hippo

本地 Agent 已经具备很强的任务执行能力，但在持续使用中仍缺少几个重要部分：

1. Codex 的会话以执行目录为中心，缺少由应用统一管理的工作区、会话和知识授权关系。
2. Codex 没有内建向量知识库，无法直接检索大量本地领域文档。
3. 单一 Agent 很难稳定表达角色切换、阶段推进、并行任务和结果审核等协作过程。
4. Skill、MCP、系统提示词和权限配置分散，难以沉淀为可复用的 Agent 类型。

Hippo 在保留本地 Runtime 原生能力的前提下，为这些问题提供应用层抽象。

## 核心能力

### 工作区

Hippo 使用“工作区”组织本地任务。每个工作区拥有：

- 应用管理的本地目录
- 独立的多会话历史
- 可使用的 Agent 列表
- 关联的知识库与主题范围
- Codex Session 与 Hippo Session 的映射

新工作区统一创建在 Hippo 系统目录的 `workspaces/` 下，不需要用户每次手动选择或创建执行路径。

### 知识库与本地 RAG

Hippo 在系统目录的 `knowledge/` 下管理两级知识结构：

- **一级知识库**：领域和授权边界，例如“平台研发”或“财务制度”
- **二级主题**：领域内的细分知识类型，例如“API 文档”或“报销规则”

一级知识库和二级主题都包含名称、描述和目录元数据。工作区关联一级知识库，并可进一步筛选允许访问的二级主题。

每个二级主题映射到一个 RAG Provider Workspace。当前 AnythingLLM 负责文档同步、Embedding 和向量召回；Hippo 负责授权范围、主题索引和检索入口。

RAG 是**节点级工具能力**，不是每轮对话前自动执行的步骤：

- 节点未启用 RAG 时，不向该节点注入 RAG MCP。
- 节点启用 RAG 后，只获得工作区授权范围内的只读检索工具。
- 模型根据当前任务自行判断是否需要检索。
- 每个节点独立配置 Top N，Hippo 在工具服务端强制执行该上限。

Embedding 模型可以部署在本地，从而降低长期 RAG 成本，并补足 Codex 本身没有向量检索能力的问题。AnythingLLM 被封装在 `RagProvider` 后面，不是不可替换的核心依赖。

### Agent 蓝图

Hippo 中的 Agent 是一份可复用的能力蓝图，而不是另一个模型服务。一个节点可以配置：

- 对 RootAgent 可见的接口描述
- 节点执行使用的系统提示词
- Skill 与 MCP 能力
- Runtime 与执行权限
- 命令执行审批和结果审核规则
- 可选的 RAG 工具与 Top N
- 节点结果处置规则

Agent 蓝图可以只有一个 Root 节点，也可以包含多个通过默认拓扑连接的节点。用户不需要在创建时区分“单 Agent”或“DAG Agent”。

蓝图使用版本化 JSON Schema 作为持久化和交换契约。当前版本为 `Agent Blueprint v1`，规范文件位于 `schemas/agent-blueprint-v1.schema.json`：

- `$schema` 和 `schemaVersion` 标识蓝图契约版本。
- `version` 是具体 Agent 的修订版本，创建时由服务端置为 `1`，每次编辑递增。
- 编辑必须携带读取时的 `expectedVersion`，避免覆盖其他会话中的新修改。
- `single` Agent 不包含运行图；`dag` Agent 的 `rootNodeId` 固定为 `root`，并校验节点、连线、环路和 Root 可达性。
- Agent 蓝图只描述原型。Session、NodeRun、输入输出、状态和 Trace 属于独立的运行时图。

REST 提供 `/api/agents/schema`、`/api/agents/validate` 和 `/api/agents` 下的创建、查看、编辑、删除接口。完整系统 MCP 提供对应的 `hippo_get_agent_schema`、`hippo_validate_agent_graph`、`hippo_create_agent`、`hippo_get_agent`、`hippo_update_agent` 和 `hippo_delete_agent` 工具。

项目内置 `.agents/skills/hippo-agent-builder` Skill。它要求模型先读取实时 Schema，再设计和校验蓝图；只有用户明确要求创建或更新时才写入，并通过 `expectedVersion` 处理并发编辑。Skill/MCP 名称不会被凭空生成，未接通 MCP 时只返回可导入的蓝图，不会声称已经保存。

首页的“导入 hippo-agent-builder 到 Codex”会把该 Skill 安装或更新到 `CODEX_HOME/skills/hippo-agent-builder`；未设置 `CODEX_HOME` 时使用 `~/.codex/skills/hippo-agent-builder`。安装后从 Hippo 新建的 Codex 会话会加载该 Skill。

### 多 Agent 协作

多节点 Agent 使用 RootAgent 协调执行：

1. RootAgent 持有冻结的 Agent 蓝图和当前运行图视图。
2. RootAgent 根据节点接口描述决定调用哪个 Worker。
3. 每次 Worker 执行创建独立的 NodeRun Attempt 和 Runtime Session。
4. 节点输入、输出、错误、审核状态和 Trace 持久化到运行图。
5. RootAgent 读取节点输出及其结果处置规则，再决定继续、并行派发、重试、请求用户或结束任务。

静态连线描述默认拓扑，不是硬编码的工作流条件。复杂的角色切换和阶段判断由 RootAgent 结合任务上下文完成。

## 架构概览

```text
Hippo Desktop / Web UI
          |
          v
Hippo Local Service
  |- Workspace & Session Manager
  |- Knowledge Metadata & Authorization
  |- Agent Blueprint Store
  |- RootAgent Graph Runtime
  |- Runtime Adapter
  |     `- Codex Runtime
  |- RagProvider
  |     `- AnythingLLM
  `- System / Graph / RAG MCP APIs
```

默认系统目录：

```text
~/.hippo/
  workspaces/   # 工作区本地目录
  knowledge/    # 两级知识库目录与文档
  agents/       # Agent、工作区、会话和运行图数据
```

系统路径、默认 Runtime、Codex 权限和 RAG Provider 地址都可以在应用设置中配置。

## 安装与部署

Hippo 当前以本地开发版运行，不需要 Docker，也没有独立的云端服务。桌面窗口、Hippo Service、Codex CLI 和 AnythingLLM Desktop 都运行在本机。

### 1. 前置条件

- Node.js 20+
- npm 10+
- 最新版 Codex CLI，并已完成登录
- 可选：AnythingLLM Desktop；仅在需要知识库和 RAG 时安装

检查 Runtime：

```sh
node --version
npm --version
codex --version
codex login
```

Codex 模型和 Service Tier 会优先从环境变量读取，其次自动读取 `~/.codex/config.toml`，通常不需要在 Hippo 中重复填写。

### 2. 安装 AnythingLLM Desktop

macOS 推荐通过 Homebrew 安装本地桌面版：

```sh
brew install --cask anythingllm
open -a AnythingLLM
```

首次启动后完成以下配置：

1. Embedding 选择本地模型。AnythingLLM 内置的 `all-MiniLM-L6-v2` 即可直接使用，也可以改为本机 Ollama 提供的向量模型。
2. Vector Database 使用本地 LanceDB。
3. 在“设置 -> Developer API”中创建一个供 Hippo 使用的 API Key。

Hippo 只调用 AnythingLLM 的文档管理、向量化和检索 API，不使用 AnythingLLM 进行对话，因此不需要为 Hippo 配置 AnythingLLM 的大模型 API Key。AnythingLLM 必须保持运行，其 Desktop 后端默认监听 `http://127.0.0.1:3001`。

### 3. 安装 Hippo

在项目根目录执行：

```sh
npm install
```

常规桌面运行不需要创建 `.env`。首次打开 Hippo 后，在“系统设置”中：

1. 确认 Codex CLI 检测成功。
2. 将 AnythingLLM 地址设置为 `http://localhost:3001`。
3. 填入 Developer API Key 并点击“测试连接”。
4. 按需设置 Hippo 系统目录和 Codex 默认文件权限。

macOS 上通过界面保存的 AnythingLLM API Key 会写入系统 Keychain，不会写入项目文件。

### 4. 启动桌面应用

先确保 AnythingLLM 已运行，再启动 Hippo：

```sh
open -a AnythingLLM
npm run desktop
```

`npm run desktop` 会启动 Electron 窗口，并自动启动 `src/server.js` 作为本地 Sidecar。默认从 `8787` 开始选择可用端口；退出 Hippo Desktop 时，它启动的 Sidecar 会一并停止。

如果需要复用已经单独启动的 Hippo Service：

```sh
npm start
HIPPO_REUSE_EXISTING_WRAPPER=1 npm run desktop
```

### 5. 仅启动 Web 服务

不使用 Electron 时可以直接运行：

```sh
npm start
```

默认访问地址：<http://127.0.0.1:8787>

这种方式适合浏览器调试或本机常驻运行。停止服务时在启动它的终端按 `Ctrl+C`。

### 6. 验证部署

```sh
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/status
```

`/api/status` 中应满足：

- `wrapper.ok` 为 `true`
- 启用 RAG 时，`anythingllm.ok` 为 `true`
- `anythingllm.auth.authenticated` 为 `true`

AnythingLLM 本身也可以单独检查：

```sh
curl http://127.0.0.1:3001/api/ping
```

### 无界面部署配置

自动化启动或不便使用系统设置页面时，可以复制示例配置：

```sh
cp .env.example .env
```

再按需填写 `ANYTHINGLLM_API_KEY`。环境变量优先级高于应用内凭据；一旦设置该变量，界面不会覆盖它。`.env` 已被 Git 忽略，不应提交任何 API Key。

### 常见问题

- `fetch failed`：AnythingLLM 没有运行，或配置的地址和实际监听端口不一致。
- `No valid api key found`：AnythingLLM 已连接，但 Hippo 使用的不是当前 Desktop 实例生成的 Developer API Key。
- Codex 提示模型要求新版：升级 Codex CLI 后重新启动 Hippo。
- `8787` 已占用：Desktop 会自动尝试后续端口；单独运行服务时可通过 `WRAPPER_PORT` 指定端口。

## MCP

本地服务提供 Streamable HTTP MCP：

```text
http://127.0.0.1:8787/mcp
```

该端点提供工作区、知识库、Agent 和运行图管理工具。启用节点级 RAG 后，Runtime 会收到一个绑定工作区和 Top N 的专用 RAG MCP，只暴露：

- `hippo_rag_scope`
- `hippo_rag_list_documents`
- `hippo_rag_search`

完整系统 MCP 按工作区配置注入。默认工作区默认开启，因此 `hippo-agent-builder` 可以读取实时 Schema，并在用户确认后直接校验、创建或更新智能体；其他工作区默认关闭，可在工作区设置中显式开启。RAG MCP 独立按节点配置注入，未启用 RAG 的节点不会获得检索工具。

也可以通过 stdio 启动完整系统 MCP：

```sh
npm run mcp
```

## Chrome 扩展

`apps/chrome-extension` 提供一个可选的浏览器侧边栏，用于选择 Hippo 工作区、发起对话，以及把当前页面或选中文本写入知识库。

开发安装：

```sh
npm run install:chrome-extension
```

## 当前状态

Hippo 仍处于快速开发阶段。目前重点是：

- 完善 Codex Session、权限、取消和流式事件适配
- 稳定 RootAgent 与 NodeRun 运行协议
- 完善可视化 Agent 蓝图编辑器
- 完善知识同步、主题检索和本地 Embedding 方案
- 抽象更多 Runtime 与 RAG Provider

Agent 运行图设计见 [docs/root-agent-runtime.md](docs/root-agent-runtime.md)，智能体构建 Skill 的多轮评价记录见 [docs/agent-builder-skill-evaluation.md](docs/agent-builder-skill-evaluation.md)。

## 开发检查

```sh
npm run check
```

该命令对服务端、Runtime Adapter、桌面端、Web UI 和 Chrome 扩展执行 JavaScript 语法检查。
