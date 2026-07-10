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

## 本地运行

### 前置条件

- Node.js 20+
- 已安装并完成认证的 Codex CLI
- 可选：AnythingLLM 实例及 Developer API Key
- 可选：本地 Embedding 服务，例如 Ollama 托管的向量模型

AnythingLLM 可以是本机已有服务，也可以部署在其他可访问地址。Hippo 本身直接在本地运行，不要求使用 Docker。

### 安装

```sh
npm install
cp .env.example .env
```

需要使用 RAG 时，在 `.env` 中配置：

```sh
ANYTHINGLLM_BASE_URL=http://localhost:3001
ANYTHINGLLM_API_KEY=your-anythingllm-developer-api-key
WRAPPER_PORT=8787
```

### 启动桌面应用

```sh
npm run desktop
```

Desktop 会检查本地 Hippo Service；如果服务尚未运行，会自动启动 `src/server.js` 作为本地 Sidecar。

也可以只启动本地服务和 Web UI：

```sh
npm start
```

默认地址：<http://127.0.0.1:8787>

## MCP

本地服务提供 Streamable HTTP MCP：

```text
http://127.0.0.1:8787/mcp
```

该端点提供工作区、知识库、Agent 和运行图管理工具。启用节点级 RAG 后，Runtime 会收到一个绑定工作区和 Top N 的专用 RAG MCP，只暴露：

- `hippo_rag_scope`
- `hippo_rag_search`

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

Agent 运行图设计见 [docs/root-agent-runtime.md](docs/root-agent-runtime.md)。

## 开发检查

```sh
npm run check
```

该命令对服务端、Runtime Adapter、桌面端、Web UI 和 Chrome 扩展执行 JavaScript 语法检查。
