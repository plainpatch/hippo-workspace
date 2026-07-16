# Hippo 本地持久化

Hippo 将可查询元数据与大体积内容分开保存：SQLite 是唯一元数据索引，文件系统保存工作区、知识文档、消息正文、运行输入输出、上下文正文和事件段。

## 系统目录

默认资源根目录为 `~/.hippo/`：

```text
~/.hippo/
  app-settings.json          # 启动前必须读取的少量应用设置
  metadata/
    hippo.sqlite3            # 核心元数据与文件索引
    hippo.sqlite3-wal        # SQLite WAL 运行文件
    hippo.sqlite3-shm
  objects/
    sha256/                  # 消息、运行载荷、Context 的不可变内容对象
  runs/
    <run-id>/                # 唯一一份 append-only JSONL Trace 分段
  workspaces/
    <workspace>/             # Codex 实际工作目录、附件和任务产物
  knowledge/
    <domain>/<topic>/        # 两级知识库原始文档
```

AnythingLLM 的向量、Embedding 和内部 Workspace 数据由 AnythingLLM 自己持久化。Hippo 只保存主题映射、同步状态和文档引用。

## SQLite 职责

- `workspaces`：工作区元信息及本地路径。
- `agents` / `agent_versions`：智能体当前版本与不可变蓝图版本。
- `conversations` / `messages` / `conversation_messages`：会话摘要、顺序和正文对象引用。
- `runtime_sessions`：Hippo Session、Run/NodeRun 与 Codex Session 的映射。
- `runs` / `node_runs`：运行图状态和输入输出对象引用。
- `run_event_segments` / `run_event_index`：Trace 分段、序号、类型和字节位置索引。
- `knowledge_*`：领域、主题、文档和 RAG Workspace 元数据。
- `context_*`：会话上下文条目、版本、标签和正文对象引用。
- `artifacts`：工作区附件与产物的路径、类型、Hash 和来源索引。
- `storage_objects`：内容寻址对象的 Hash、路径、类型和大小。

数据库启用 WAL、外键、busy timeout 和 `synchronous=NORMAL`。单次业务变更在 SQLite 事务中更新关系数据；大内容先原子写入文件，再提交对象引用。文件写入失败不会生成元数据，数据库提交失败只可能留下未引用对象，可由 GC 清理。

## 文件策略

消息、运行载荷和 Context 使用 SHA-256 内容寻址。相同正文只保存一次，版本和会话通过 SQLite 引用同一对象。Run Trace 只保存一份，Node Trace 通过 `node_run_id` 索引过滤，不再复制到 Run 与 Node 两套 JSON 中。

工作区文件和知识文档保持用户可直接访问的目录结构，不复制到对象库。SQLite 保存相对路径、Hash、大小、更新时间和业务归属，Runtime 仍使用工作区绝对路径读写文件。

## 备份与恢复

完整备份必须覆盖整个资源根目录。运行中备份 SQLite 时应使用 SQLite backup API 或先执行 checkpoint；不能只复制 `hippo.sqlite3` 而遗漏 WAL。应用完全退出后，可以直接复制整个 `~/.hippo/`。

恢复时先退出 Hippo，再整体替换资源目录。数据库记录中的工作区路径均指向同一资源根目录下的工作区；若用户修改了系统路径，应通过应用设置完成路径切换。

## 清理策略

当前不会自动删除用户工作区和知识文档。后续 GC 只处理以下内容：

- `storage_objects` 未引用的内容对象；
- 已关闭 Run 的过期 Trace 分段；
- 已删除会话产生且未被 Artifact/Context 引用的文件；
- 临时上传和原子写入残留的 `.tmp` 文件。

GC 必须先从 SQLite 计算引用集合，再删除文件；不能按目录时间直接清理。
