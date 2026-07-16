import { createHash } from "node:crypto";

export class HippoRepository {
  constructor({ database, objectStore, eventStore }) {
    this.database = database;
    this.db = database.db;
    this.objectStore = objectStore;
    this.eventStore = eventStore;
  }

  listWorkspaces() {
    return this.db.prepare("SELECT * FROM workspaces ORDER BY updated_at DESC").all().map((row) => this.mapWorkspace(row));
  }

  getWorkspace(id) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? this.mapWorkspace(row) : null;
  }

  saveWorkspace(workspace) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workspaces(
        id, name, description, local_path, folder_name, hippo_mcp_enabled,
        metadata_json, created_at, updated_at
      ) VALUES (@id, @name, @description, @localPath, @folderName, @hippoMcpEnabled,
        @metadataJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        local_path = excluded.local_path,
        folder_name = excluded.folder_name,
        hippo_mcp_enabled = excluded.hippo_mcp_enabled,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run({
      id: workspace.id,
      name: workspace.name,
      description: workspace.description || "",
      localPath: workspace.localWorkspacePath || "",
      folderName: workspace.localWorkspaceFolderName || "",
      hippoMcpEnabled: workspace.hippoMcpEnabled === true ? 1 : 0,
      metadataJson: json(workspace.metadata || {}),
      createdAt: workspace.createdAt || now,
      updatedAt: workspace.updatedAt || now,
    });
  }

  deleteWorkspace(id) {
    return this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id).changes > 0;
  }

  getWorkspaceByPath(workspacePath) {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE local_path = ?").get(workspacePath);
    return row ? this.mapWorkspace(row) : null;
  }

  listAgents() {
    return this.db.prepare(`
      SELECT a.*, v.blueprint_json
      FROM agents a
      JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
      ORDER BY a.updated_at DESC
    `).all().map(mapAgent);
  }

  getAgent(id, version) {
    const row = version
      ? this.db.prepare(`
          SELECT a.*, v.blueprint_json FROM agents a
          JOIN agent_versions v ON v.agent_id = a.id
          WHERE a.id = ? AND v.version = ?
        `).get(id, version)
      : this.db.prepare(`
          SELECT a.*, v.blueprint_json FROM agents a
          JOIN agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
          WHERE a.id = ?
        `).get(id);
    return row ? mapAgent(row) : null;
  }

  saveAgent(agent) {
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agents(id, name, type, current_version, description, created_at, updated_at)
        VALUES (@id, @name, @type, @version, @description, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          current_version = excluded.current_version,
          description = excluded.description,
          updated_at = excluded.updated_at
      `).run({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        version: agent.version || 1,
        description: agent.description || "",
        createdAt: agent.createdAt || now,
        updatedAt: agent.updatedAt || now,
      });
      this.db.prepare(`
        INSERT INTO agent_versions(agent_id, version, schema_version, blueprint_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, version) DO UPDATE SET blueprint_json = excluded.blueprint_json
      `).run(agent.id, agent.version || 1, String(agent.schemaVersion || "1"), json(agent), agent.updatedAt || now);
    });
    transaction();
  }

  deleteAgent(id) {
    return this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0;
  }

  readKnowledgeIndex() {
    const drawers = {};
    for (const row of this.db.prepare("SELECT * FROM knowledge_domains ORDER BY relative_path").all()) {
      drawers[row.relative_path] = {
        path: row.relative_path,
        level: 1,
        name: row.name,
        description: row.description,
        enabled: row.enabled === 1,
        metadata: parseJson(row.metadata_json) || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    for (const row of this.db.prepare("SELECT * FROM knowledge_topics ORDER BY relative_path").all()) {
      drawers[row.relative_path] = {
        path: row.relative_path,
        level: 2,
        name: row.name,
        description: row.description,
        enabled: row.enabled === 1,
        metadata: parseJson(row.metadata_json) || {},
        rag: {
          providerId: row.rag_provider_id,
          workspaceSlug: row.rag_workspace_slug,
          status: row.rag_status,
          error: row.rag_error,
          syncedAt: row.synced_at,
          updatedAt: row.updated_at,
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    const documents = {};
    for (const row of this.db.prepare("SELECT * FROM knowledge_documents ORDER BY relative_path").all()) {
      documents[row.relative_path] = {
        ...(parseJson(row.metadata_json) || {}),
        id: row.id,
        relativePath: row.relative_path,
        title: row.title,
        type: row.document_type,
        documentNames: parseJson(row.rag_document_refs_json) || [],
        sourceHash: row.content_hash || undefined,
        sourceSize: row.size_bytes,
        sourceMtimeMs: row.mtime_ms,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    return { version: 1, drawers, documents };
  }

  writeKnowledgeIndex(index) {
    const domains = Object.values(index.drawers || {}).filter((item) => item.level === 1);
    const topics = Object.values(index.drawers || {}).filter((item) => item.level === 2);
    const documents = Object.values(index.documents || {});
    const transaction = this.db.transaction(() => {
      const upsertDomain = this.db.prepare(`
        INSERT INTO knowledge_domains(
          id, relative_path, name, description, enabled, metadata_json, created_at, updated_at
        ) VALUES (@id, @path, @name, @description, @enabled, @metadataJson, @createdAt, @updatedAt)
        ON CONFLICT(relative_path) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          enabled = excluded.enabled,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `);
      for (const domain of domains) upsertDomain.run(drawerRow(domain, "domain"));

      const upsertTopic = this.db.prepare(`
        INSERT INTO knowledge_topics(
          id, domain_id, relative_path, name, description, enabled, metadata_json,
          rag_provider_id, rag_workspace_slug, rag_status, rag_error, synced_at, created_at, updated_at
        ) VALUES (@id, @domainId, @path, @name, @description, @enabled, @metadataJson,
          @ragProviderId, @ragWorkspaceSlug, @ragStatus, @ragError, @syncedAt, @createdAt, @updatedAt)
        ON CONFLICT(relative_path) DO UPDATE SET
          domain_id = excluded.domain_id,
          name = excluded.name,
          description = excluded.description,
          enabled = excluded.enabled,
          metadata_json = excluded.metadata_json,
          rag_provider_id = excluded.rag_provider_id,
          rag_workspace_slug = excluded.rag_workspace_slug,
          rag_status = excluded.rag_status,
          rag_error = excluded.rag_error,
          synced_at = excluded.synced_at,
          updated_at = excluded.updated_at
      `);
      for (const topic of topics) {
        const domainPath = topic.path.split("/")[0];
        const domain = this.db.prepare("SELECT id FROM knowledge_domains WHERE relative_path = ?").get(domainPath);
        if (!domain) throw new Error(`Knowledge domain ${domainPath} is missing.`);
        upsertTopic.run({ ...drawerRow(topic, "topic"), domainId: domain.id });
      }

      const upsertDocument = this.db.prepare(`
        INSERT INTO knowledge_documents(
          id, topic_id, relative_path, title, document_type, content_hash, size_bytes,
          mtime_ms, rag_document_refs_json, metadata_json, created_at, updated_at
        ) VALUES (@id, @topicId, @relativePath, @title, @documentType, @contentHash, @sizeBytes,
          @mtimeMs, @ragDocumentRefsJson, @metadataJson, @createdAt, @updatedAt)
        ON CONFLICT(relative_path) DO UPDATE SET
          topic_id = excluded.topic_id,
          title = excluded.title,
          document_type = excluded.document_type,
          content_hash = excluded.content_hash,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          rag_document_refs_json = excluded.rag_document_refs_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `);
      for (const document of documents) {
        const topicPath = document.topicPath || String(document.relativePath || "").split("/").slice(0, 2).join("/");
        const topic = this.db.prepare("SELECT id FROM knowledge_topics WHERE relative_path = ?").get(topicPath);
        if (!topic) continue;
        const now = new Date().toISOString();
        const metadata = { ...document };
        for (const key of ["id", "relativePath", "title", "type", "documentNames", "sourceHash", "sourceSize", "sourceMtimeMs", "createdAt", "updatedAt"]) {
          delete metadata[key];
        }
        upsertDocument.run({
          id: document.id || stableId("document", document.relativePath),
          topicId: topic.id,
          relativePath: document.relativePath,
          title: document.title || document.relativePath,
          documentType: document.type || "file",
          contentHash: document.sourceHash || null,
          sizeBytes: document.sourceSize || 0,
          mtimeMs: document.sourceMtimeMs || null,
          ragDocumentRefsJson: json(document.documentNames || []),
          metadataJson: json(metadata),
          createdAt: document.createdAt || now,
          updatedAt: document.updatedAt || now,
        });
      }
      deleteKnowledgeRowsNotIn(
        this.db,
        "knowledge_documents",
        "relative_path",
        new Set(documents.map((item) => item.relativePath))
      );
      deleteKnowledgeRowsNotIn(this.db, "knowledge_topics", "relative_path", new Set(topics.map((item) => item.path)));
      deleteKnowledgeRowsNotIn(this.db, "knowledge_domains", "relative_path", new Set(domains.map((item) => item.path)));
    });
    transaction();
  }

  replaceWorkspaceAgentRefs(workspaceId, agentIds = []) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM workspace_agent_refs WHERE workspace_id = ?").run(workspaceId);
      const insert = this.db.prepare(
        "INSERT INTO workspace_agent_refs(workspace_id, agent_id, position) VALUES (?, ?, ?)"
      );
      agentIds.forEach((agentId, position) => insert.run(workspaceId, agentId, position));
    });
    transaction();
  }

  replaceWorkspaceKnowledgeRefs(workspaceId, domainPaths = [], topicPaths = []) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM workspace_knowledge_domain_refs WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM workspace_knowledge_topic_refs WHERE workspace_id = ?").run(workspaceId);
      const insertDomain = this.db.prepare(`
        INSERT INTO workspace_knowledge_domain_refs(workspace_id, domain_path) VALUES (?, ?)
      `);
      const insertTopic = this.db.prepare(`
        INSERT INTO workspace_knowledge_topic_refs(workspace_id, topic_path) VALUES (?, ?)
      `);
      for (const domainPath of domainPaths) insertDomain.run(workspaceId, domainPath);
      for (const topicPath of topicPaths) insertTopic.run(workspaceId, topicPath);
    });
    transaction();
  }

  listConversationSummaries(workspaceId) {
    return this.db.prepare(`
      SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC
    `).all(workspaceId).map(mapConversationSummary);
  }

  async getConversation(workspaceId, conversationId) {
    const row = this.db.prepare(`
      SELECT * FROM conversations WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, conversationId);
    if (!row) return null;
    const messages = [];
    const rows = this.db.prepare(`
      SELECT m.*, o.relative_path
      FROM conversation_messages cm
      JOIN messages m ON m.id = cm.message_id
      JOIN storage_objects o ON o.id = m.body_object_id
      WHERE cm.conversation_id = ?
      ORDER BY cm.sequence
    `).all(conversationId);
    for (const message of rows) messages.push(await this.objectStore.readJson(message.relative_path));
    const runtimeSessions = Object.fromEntries(this.db.prepare(`
      SELECT * FROM runtime_sessions
      WHERE conversation_id = ? AND run_id IS NULL AND node_run_id IS NULL
      ORDER BY created_at
    `).all(conversationId).map((session) => [session.runtime_id, mapRuntimeSession(session)]));
    const runIds = this.db.prepare(`
      SELECT id FROM runs WHERE conversation_id = ? ORDER BY created_at
    `).all(conversationId).map((run) => run.id);
    return { ...mapConversationSummary(row), messages, runtimeSessions, runIds };
  }

  async saveConversation(conversation) {
    const now = new Date().toISOString();
    const storedMessages = [];
    for (const [sequence, message] of (conversation.messages || []).entries()) {
      const object = await this.objectStore.putJson(message);
      this.registerObject(object, now);
      const id = messageStorageId(message, object.hash);
      storedMessages.push({ id, sequence, object, message });
    }
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO conversations(
          id, workspace_id, type, title, active_agent_id, parent_conversation_id,
          message_count, last_message_preview, metadata_json, created_at, updated_at
        ) VALUES (@id, @workspaceId, @type, @title, @activeAgentId, @parentConversationId,
          @messageCount, @lastMessagePreview, @metadataJson, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          active_agent_id = excluded.active_agent_id,
          parent_conversation_id = excluded.parent_conversation_id,
          message_count = excluded.message_count,
          last_message_preview = excluded.last_message_preview,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `).run({
        id: conversation.id,
        workspaceId: conversation.workspaceId,
        type: conversation.type || "root",
        title: conversation.title || "新对话",
        activeAgentId: conversation.activeAgentId || null,
        parentConversationId: conversation.parentConversationId || null,
        messageCount: storedMessages.length,
        lastMessagePreview: preview(conversation.messages?.at(-1)?.text),
        metadataJson: json(conversation.metadata || {}),
        createdAt: conversation.createdAt || now,
        updatedAt: conversation.updatedAt || now,
      });
      this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id = ?").run(conversation.id);
      const insertMessage = this.db.prepare(`
        INSERT INTO messages(id, role, body_object_id, run_id, preview, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `);
      const linkMessage = this.db.prepare(`
        INSERT INTO conversation_messages(conversation_id, sequence, message_id) VALUES (?, ?, ?)
      `);
      for (const item of storedMessages) {
        insertMessage.run(
          item.id,
          item.message.role,
          item.object.id,
          item.message.runId || null,
          preview(item.message.text),
          json(item.message.metadata || {}),
          item.message.createdAt || now
        );
        linkMessage.run(conversation.id, item.sequence, item.id);
      }
      this.db.prepare(`
        DELETE FROM runtime_sessions
        WHERE conversation_id = ? AND run_id IS NULL AND node_run_id IS NULL
      `).run(conversation.id);
      const insertRuntimeSession = this.db.prepare(`
        INSERT INTO runtime_sessions(
          id, conversation_id, run_id, node_run_id, runtime_id, provider_session_id,
          resumed_from_session_id, workspace_path, status, created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [runtimeId, session] of Object.entries(conversation.runtimeSessions || {})) {
        insertRuntimeSession.run(
          `session_${createHash("sha256").update(`${conversation.id}\0${runtimeId}`).digest("hex")}`,
          conversation.id,
          runtimeId,
          session.sessionId,
          session.resumedFromSessionId || "",
          session.workspacePath || "",
          session.status || "active",
          session.createdAt || now,
          session.updatedAt || now
        );
      }
      this.deleteUnreferencedMessages();
    });
    transaction();
  }

  deleteConversation(workspaceId, conversationId) {
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM conversations WHERE workspace_id = ? AND id = ?")
        .run(workspaceId, conversationId);
      this.deleteUnreferencedMessages();
      return result.changes > 0;
    });
    return transaction();
  }

  async saveRun(run) {
    const now = new Date().toISOString();
    const [request, input, output, snapshot] = await Promise.all([
      this.storeOptionalJson(run.request),
      this.storeOptionalJson(run.input),
      this.storeOptionalJson(run.output),
      this.storeOptionalJson(run.agentSnapshot),
    ]);
    const nodes = [];
    for (const node of Object.values(run.nodeRuns || {})) {
      nodes.push({
        node,
        input: await this.storeOptionalJson(node.input),
        output: await this.storeOptionalJson(node.output),
      });
    }
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO runs(
          id, workspace_id, conversation_id, agent_id, agent_version, status, managed,
          request_object_id, input_object_id, output_object_id, snapshot_object_id,
          error_json, coordinator_json, created_at, updated_at
        ) VALUES (@id, @workspaceId, @conversationId, @agentId, @agentVersion, @status, @managed,
          @requestObjectId, @inputObjectId, @outputObjectId, @snapshotObjectId,
          @errorJson, @coordinatorJson, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          request_object_id = excluded.request_object_id,
          input_object_id = excluded.input_object_id,
          output_object_id = excluded.output_object_id,
          snapshot_object_id = excluded.snapshot_object_id,
          error_json = excluded.error_json,
          coordinator_json = excluded.coordinator_json,
          updated_at = excluded.updated_at
      `).run({
        id: run.id,
        workspaceId: run.workspaceId,
        conversationId: run.rootSessionId || null,
        agentId: run.agentId || null,
        agentVersion: run.agentVersion || null,
        status: run.status,
        managed: run.managed === false ? 0 : 1,
        requestObjectId: request?.id || null,
        inputObjectId: input?.id || null,
        outputObjectId: output?.id || null,
        snapshotObjectId: snapshot?.id || null,
        errorJson: nullableJson(run.error),
        coordinatorJson: nullableJson(run.rootCoordinator),
        createdAt: run.createdAt || now,
        updatedAt: run.updatedAt || now,
      });
      this.db.prepare("DELETE FROM node_runs WHERE run_id = ?").run(run.id);
      const insertNode = this.db.prepare(`
        INSERT INTO node_runs(
          id, run_id, node_id, prototype_node_id, parent_node_run_id, attempt, status,
          agent_id, runtime_run_id, runtime_session_json, input_object_id, output_object_id,
          error_json, approval_json, graph_json, created_at, updated_at
        ) VALUES (@id, @runId, @nodeId, @prototypeNodeId, @parentNodeRunId, @attempt, @status,
          @agentId, @runtimeRunId, @runtimeSessionJson, @inputObjectId, @outputObjectId,
          @errorJson, @approvalJson, @graphJson, @createdAt, @updatedAt)
      `);
      for (const item of nodes) {
        const node = item.node;
        insertNode.run({
          id: node.id,
          runId: run.id,
          nodeId: node.nodeId,
          prototypeNodeId: node.prototypeNodeId || node.nodeId,
          parentNodeRunId: node.parentNodeRunId || null,
          attempt: node.attempt || 1,
          status: node.status,
          agentId: node.agentId || null,
          runtimeRunId: node.runtimeRunId || "",
          runtimeSessionJson: nullableJson(node.runtimeSession),
          inputObjectId: item.input?.id || null,
          outputObjectId: item.output?.id || null,
          errorJson: nullableJson(node.error),
          approvalJson: nullableJson(node.approval),
          graphJson: json({
            upstreamNodeIds: node.upstreamNodeIds || [],
            downstreamNodeIds: node.downstreamNodeIds || [],
            kind: node.kind || "task",
          }),
          createdAt: node.createdAt || now,
          updatedAt: node.updatedAt || now,
        });
      }
    });
    transaction();
  }

  async getRun(workspaceId, runId, { includeEvents = false } = {}) {
    const row = this.db.prepare("SELECT * FROM runs WHERE workspace_id = ? AND id = ?").get(workspaceId, runId);
    if (!row) return null;
    return this.hydrateRun(row, { includeEvents });
  }

  async listRuns(workspaceId, { conversationId = "", statuses = [], includeEvents = false } = {}) {
    const clauses = ["workspace_id = ?"];
    const parameters = [workspaceId];
    if (conversationId) {
      clauses.push("conversation_id = ?");
      parameters.push(conversationId);
    }
    if (statuses.length) {
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    }
    const rows = this.db.prepare(`
      SELECT * FROM runs WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC
    `).all(...parameters);
    const runs = [];
    for (const row of rows) runs.push(await this.hydrateRun(row, { includeEvents }));
    return runs;
  }

  deleteRun(workspaceId, runId) {
    return this.db.prepare("DELETE FROM runs WHERE workspace_id = ? AND id = ?").run(workspaceId, runId).changes > 0;
  }

  async writeContextItem({ workspaceId, sessionId, contextId, title, summary, content, contentType, tags, source, expectedVersion }) {
    const current = this.getContextItem(workspaceId, sessionId, contextId);
    const latestVersion = current?.latestVersion || 0;
    if (expectedVersion !== undefined && Number(expectedVersion) !== latestVersion) {
      const error = new Error("Context version conflict.");
      error.code = "CONTEXT_VERSION_CONFLICT";
      error.actualVersion = latestVersion;
      throw error;
    }
    const object = await this.objectStore.put(content, { contentType });
    this.registerObject(object);
    const latest = current?.versions.at(-1);
    if (latest?.objectId === object.id) return current;
    const now = new Date().toISOString();
    const version = latestVersion + 1;
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO context_items(
          id, workspace_id, session_id, context_key, conversation_id, title, summary, latest_version, created_at, updated_at
        ) VALUES (@id, @workspaceId, @sessionId, @contextKey, @conversationId, @title, @summary, @version, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          latest_version = excluded.latest_version,
          updated_at = excluded.updated_at
      `).run({
        id: stableId("context", `${workspaceId}:${sessionId}:${contextId}`),
        workspaceId,
        sessionId,
        contextKey: contextId,
        conversationId: this.db.prepare("SELECT id FROM conversations WHERE id = ? AND workspace_id = ?").get(sessionId, workspaceId)?.id || null,
        title,
        summary,
        version,
        createdAt: current?.createdAt || now,
        updatedAt: now,
      });
      this.db.prepare(`
        INSERT INTO context_versions(context_id, version, object_id, source_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(stableId("context", `${workspaceId}:${sessionId}:${contextId}`), version, object.id, json(source || {}), now);
      const storageId = stableId("context", `${workspaceId}:${sessionId}:${contextId}`);
      this.db.prepare("DELETE FROM context_tags WHERE context_id = ?").run(storageId);
      const insertTag = this.db.prepare("INSERT INTO context_tags(context_id, tag) VALUES (?, ?)");
      for (const tag of tags) insertTag.run(storageId, tag);
    });
    transaction();
    return this.getContextItem(workspaceId, sessionId, contextId);
  }

  getContextItem(workspaceId, sessionId, contextId) {
    const row = this.db.prepare(`
      SELECT * FROM context_items WHERE workspace_id = ? AND session_id = ? AND context_key = ?
    `).get(workspaceId, sessionId, contextId);
    return row ? this.hydrateContextItem(row) : null;
  }

  listContextItems(workspaceId, sessionId) {
    return this.db.prepare(`
      SELECT * FROM context_items
      WHERE workspace_id = ? AND session_id = ?
      ORDER BY updated_at DESC
    `).all(workspaceId, sessionId).map((row) => this.hydrateContextItem(row));
  }

  hydrateContextItem(row) {
    const tags = this.db.prepare("SELECT tag FROM context_tags WHERE context_id = ? ORDER BY tag")
      .all(row.id).map((item) => item.tag);
    const versions = this.db.prepare(`
      SELECT v.*, o.relative_path, o.content_type, o.hash, o.size_bytes
      FROM context_versions v
      JOIN storage_objects o ON o.id = v.object_id
      WHERE v.context_id = ? ORDER BY v.version
    `).all(row.id).map((version) => ({
      version: version.version,
      objectId: version.object_id,
      path: version.relative_path,
      contentType: version.content_type,
      contentHash: `sha256:${version.hash}`,
      size: version.size_bytes,
      source: parseJson(version.source_json) || {},
      createdAt: version.created_at,
    }));
    return {
      id: row.context_key,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      title: row.title,
      summary: row.summary,
      tags,
      latestVersion: row.latest_version,
      versions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  deleteContextSession(workspaceId, sessionId) {
    return this.db.prepare("DELETE FROM context_items WHERE workspace_id = ? AND session_id = ?")
      .run(workspaceId, sessionId).changes;
  }

  saveArtifacts(artifacts) {
    const transaction = this.db.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO artifacts(
          id, workspace_id, conversation_id, run_id, node_run_id, relative_path,
          artifact_type, mime_type, content_hash, size_bytes, metadata_json, created_at, updated_at
        ) VALUES (@id, @workspaceId, @conversationId, @runId, @nodeRunId, @relativePath,
          @artifactType, @mimeType, @contentHash, @sizeBytes, @metadataJson, @createdAt, @updatedAt)
        ON CONFLICT(workspace_id, relative_path) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          run_id = excluded.run_id,
          node_run_id = excluded.node_run_id,
          artifact_type = excluded.artifact_type,
          mime_type = excluded.mime_type,
          content_hash = excluded.content_hash,
          size_bytes = excluded.size_bytes,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `);
      for (const artifact of artifacts) {
        const now = new Date().toISOString();
        upsert.run({
          id: artifact.id || stableId("artifact", `${artifact.workspaceId}:${artifact.relativePath}`),
          workspaceId: artifact.workspaceId,
          conversationId: artifact.conversationId || null,
          runId: artifact.runId || null,
          nodeRunId: artifact.nodeRunId || null,
          relativePath: artifact.relativePath,
          artifactType: artifact.artifactType || "file",
          mimeType: artifact.mimeType || "application/octet-stream",
          contentHash: artifact.contentHash || null,
          sizeBytes: artifact.sizeBytes || 0,
          metadataJson: json(artifact.metadata || {}),
          createdAt: artifact.createdAt || now,
          updatedAt: artifact.updatedAt || now,
        });
      }
    });
    transaction();
  }

  listArtifacts(workspaceId, { conversationId = "", runId = "", limit = 200, offset = 0 } = {}) {
    const clauses = ["workspace_id = ?"];
    const parameters = [workspaceId];
    if (conversationId) {
      clauses.push("conversation_id = ?");
      parameters.push(conversationId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      parameters.push(runId);
    }
    parameters.push(Math.min(500, Math.max(1, Number(limit) || 200)), Math.max(0, Number(offset) || 0));
    return this.db.prepare(`
      SELECT * FROM artifacts WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(...parameters).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id || "",
      runId: row.run_id || "",
      nodeRunId: row.node_run_id || "",
      relativePath: row.relative_path,
      artifactType: row.artifact_type,
      mimeType: row.mime_type,
      contentHash: row.content_hash || "",
      sizeBytes: row.size_bytes,
      metadata: parseJson(row.metadata_json) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async hydrateRun(row, { includeEvents }) {
    const run = {
      id: row.id,
      rootSessionId: row.conversation_id || "",
      workspaceId: row.workspace_id,
      agentId: row.agent_id || "",
      agentVersion: row.agent_version || 1,
      status: row.status,
      managed: row.managed === 1,
      request: await this.readObjectJson(row.request_object_id),
      input: await this.readObjectJson(row.input_object_id),
      output: await this.readObjectJson(row.output_object_id),
      agentSnapshot: await this.readObjectJson(row.snapshot_object_id),
      error: parseJson(row.error_json),
      rootCoordinator: parseJson(row.coordinator_json),
      nodeRuns: {},
      trace: includeEvents ? this.eventStore.list(row.id, { limit: 10_000 }) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const nodes = this.db.prepare("SELECT * FROM node_runs WHERE run_id = ? ORDER BY created_at").all(row.id);
    for (const node of nodes) {
      const graph = parseJson(node.graph_json) || {};
      run.nodeRuns[node.id] = {
        id: node.id,
        type: "node",
        runId: row.id,
        nodeId: node.node_id,
        prototypeNodeId: node.prototype_node_id,
        parentNodeRunId: node.parent_node_run_id || "",
        attempt: node.attempt,
        kind: graph.kind || "task",
        agentId: node.agent_id || "",
        status: node.status,
        runtimeRunId: node.runtime_run_id,
        runtimeSession: parseJson(node.runtime_session_json),
        input: await this.readObjectJson(node.input_object_id),
        output: await this.readObjectJson(node.output_object_id),
        error: parseJson(node.error_json),
        approval: parseJson(node.approval_json),
        upstreamNodeIds: graph.upstreamNodeIds || [],
        downstreamNodeIds: graph.downstreamNodeIds || [],
        trace: includeEvents ? run.trace.filter((event) => event.nodeRunId === node.id) : [],
        createdAt: node.created_at,
        updatedAt: node.updated_at,
      };
    }
    return run;
  }

  registerObject(object, createdAt = new Date().toISOString()) {
    this.db.prepare(`
      INSERT INTO storage_objects(id, hash, relative_path, content_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(object.id, object.hash, object.path, object.contentType, object.size, createdAt);
  }

  async storeOptionalJson(value) {
    if (value === undefined) return null;
    const object = await this.objectStore.putJson(value);
    this.registerObject(object);
    return object;
  }

  async readObjectJson(id) {
    if (!id) return undefined;
    const row = this.db.prepare("SELECT relative_path FROM storage_objects WHERE id = ?").get(id);
    return row ? this.objectStore.readJson(row.relative_path) : undefined;
  }

  deleteUnreferencedMessages() {
    this.db.prepare(`
      DELETE FROM messages WHERE id NOT IN (SELECT DISTINCT message_id FROM conversation_messages)
    `).run();
  }

  mapWorkspace(row) {
    const agentIds = this.db.prepare(`
      SELECT agent_id FROM workspace_agent_refs WHERE workspace_id = ? ORDER BY position
    `).all(row.id).map((item) => item.agent_id);
    const knowledgeDomainRefs = this.db.prepare(`
      SELECT domain_path FROM workspace_knowledge_domain_refs WHERE workspace_id = ? ORDER BY domain_path
    `).all(row.id).map((item) => item.domain_path);
    const knowledgeTopicRefs = this.db.prepare(`
      SELECT topic_path FROM workspace_knowledge_topic_refs WHERE workspace_id = ? ORDER BY topic_path
    `).all(row.id).map((item) => item.topic_path);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      hippoMcpEnabled: row.hippo_mcp_enabled === 1,
      agentIds,
      knowledgeDomainRefs,
      knowledgeTopicRefs,
      localWorkspacePath: row.local_path,
      localWorkspaceFolderName: row.folder_name,
      metadata: parseJson(row.metadata_json) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function mapAgent(row) {
  return JSON.parse(row.blueprint_json);
}

function drawerRow(drawer, prefix) {
  const now = new Date().toISOString();
  return {
    id: drawer.id || stableId(prefix, drawer.path),
    path: drawer.path,
    name: drawer.name,
    description: drawer.description || "",
    enabled: drawer.enabled === false ? 0 : 1,
    metadataJson: json(drawer.metadata || {}),
    ragProviderId: drawer.rag?.providerId || "",
    ragWorkspaceSlug: drawer.rag?.workspaceSlug || "",
    ragStatus: drawer.rag?.status || "pending",
    ragError: drawer.rag?.error || "",
    syncedAt: drawer.rag?.syncedAt || null,
    createdAt: drawer.createdAt || now,
    updatedAt: drawer.updatedAt || now,
  };
}

function stableId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(String(value || "")).digest("hex")}`;
}

function deleteKnowledgeRowsNotIn(db, table, column, values) {
  const rows = db.prepare(`SELECT ${column} value FROM ${table}`).all();
  const remove = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`);
  for (const row of rows) if (!values.has(row.value)) remove.run(row.value);
}

function mapConversationSummary(row) {
  return {
    id: row.id,
    type: row.type,
    workspaceId: row.workspace_id,
    title: row.title,
    activeAgentId: row.active_agent_id || "",
    parentConversationId: row.parent_conversation_id || "",
    messageCount: row.message_count,
    lastMessagePreview: row.last_message_preview,
    metadata: parseJson(row.metadata_json) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntimeSession(row) {
  return {
    provider: row.runtime_id,
    sessionId: row.provider_session_id,
    resumedFromSessionId: row.resumed_from_session_id,
    workspacePath: row.workspace_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageStorageId(message, objectHash) {
  return `msg_${createHash("sha256")
    .update(`${message.role}\0${message.runId || ""}\0${objectHash}`)
    .digest("hex")}`;
}

function preview(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function nullableJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value) {
  return value ? JSON.parse(value) : undefined;
}
