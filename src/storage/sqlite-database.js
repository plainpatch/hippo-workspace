import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE storage_objects (
      id TEXT PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      relative_path TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      local_path TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      hippo_mcp_enabled INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX workspaces_updated_idx ON workspaces(updated_at DESC);

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('single', 'blueprint')),
      current_version INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_versions (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      blueprint_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, version)
    );

    CREATE TABLE workspace_agent_refs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(workspace_id, agent_id)
    );

    CREATE TABLE knowledge_domains (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_topics (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES knowledge_domains(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      rag_provider_id TEXT NOT NULL DEFAULT '',
      rag_workspace_slug TEXT NOT NULL DEFAULT '',
      rag_status TEXT NOT NULL DEFAULT 'pending',
      rag_error TEXT NOT NULL DEFAULT '',
      synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX knowledge_topics_domain_idx ON knowledge_topics(domain_id);
    CREATE TABLE knowledge_documents (
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES knowledge_topics(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      document_type TEXT NOT NULL,
      content_hash TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mtime_ms REAL,
      rag_document_refs_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX knowledge_documents_topic_idx ON knowledge_documents(topic_id, updated_at DESC);

    CREATE TABLE workspace_knowledge_domain_refs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      domain_path TEXT NOT NULL,
      PRIMARY KEY(workspace_id, domain_path)
    );
    CREATE TABLE workspace_knowledge_topic_refs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      topic_path TEXT NOT NULL,
      PRIMARY KEY(workspace_id, topic_path)
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'root',
      title TEXT NOT NULL,
      active_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX conversations_workspace_updated_idx ON conversations(workspace_id, updated_at DESC);

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      body_object_id TEXT NOT NULL REFERENCES storage_objects(id),
      run_id TEXT,
      preview TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE conversation_messages (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id),
      PRIMARY KEY(conversation_id, sequence),
      UNIQUE(conversation_id, message_id)
    );
    CREATE INDEX conversation_messages_message_idx ON conversation_messages(message_id);

    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT,
      node_run_id TEXT,
      runtime_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      resumed_from_session_id TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(runtime_id, provider_session_id)
    );
    CREATE INDEX runtime_sessions_conversation_idx ON runtime_sessions(conversation_id, updated_at DESC);

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      conversation_id TEXT,
      agent_id TEXT,
      agent_version INTEGER,
      status TEXT NOT NULL,
      managed INTEGER NOT NULL DEFAULT 1,
      request_object_id TEXT REFERENCES storage_objects(id),
      input_object_id TEXT REFERENCES storage_objects(id),
      output_object_id TEXT REFERENCES storage_objects(id),
      snapshot_object_id TEXT REFERENCES storage_objects(id),
      error_json TEXT,
      coordinator_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX runs_workspace_updated_idx ON runs(workspace_id, updated_at DESC);
    CREATE INDEX runs_conversation_updated_idx ON runs(conversation_id, updated_at DESC);
    CREATE INDEX runs_status_idx ON runs(status, updated_at DESC);

    CREATE TABLE node_runs (
      id TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      prototype_node_id TEXT NOT NULL,
      parent_node_run_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      agent_id TEXT,
      runtime_run_id TEXT NOT NULL DEFAULT '',
      runtime_session_json TEXT,
      input_object_id TEXT REFERENCES storage_objects(id),
      output_object_id TEXT REFERENCES storage_objects(id),
      error_json TEXT,
      approval_json TEXT,
      graph_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, id)
    );
    CREATE INDEX node_runs_run_idx ON node_runs(run_id, created_at);
    CREATE INDEX node_runs_status_idx ON node_runs(status, updated_at DESC);

    CREATE TABLE run_event_segments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL UNIQUE,
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      event_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX run_event_segments_run_idx ON run_event_segments(run_id, first_sequence);
    CREATE TABLE run_event_index (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      segment_id TEXT NOT NULL REFERENCES run_event_segments(id) ON DELETE CASCADE,
      node_run_id TEXT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      PRIMARY KEY(run_id, sequence),
      UNIQUE(run_id, event_id)
    );
    CREATE INDEX run_event_type_idx ON run_event_index(run_id, event_type, sequence);
    CREATE INDEX run_event_node_idx ON run_event_index(node_run_id, sequence);

    CREATE TABLE context_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      context_key TEXT NOT NULL,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      latest_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, session_id, context_key)
    );
    CREATE INDEX context_items_session_idx ON context_items(workspace_id, session_id, updated_at DESC);
    CREATE TABLE context_versions (
      context_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      object_id TEXT NOT NULL REFERENCES storage_objects(id),
      source_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY(context_id, version)
    );
    CREATE TABLE context_tags (
      context_id TEXT NOT NULL REFERENCES context_items(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY(context_id, tag)
    );

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      node_run_id TEXT,
      relative_path TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      content_hash TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, relative_path)
    );
  `,
}];

export class SqliteDatabase {
  constructor({ databasePath }) {
    if (!databasePath) throw new Error("SQLite databasePath is required.");
    this.databasePath = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.configure();
    this.migrate();
  }

  configure() {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("temp_store = MEMORY");
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(this.db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
    const apply = this.db.transaction((migration) => {
      this.db.exec(migration.sql);
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    });
    for (const migration of MIGRATIONS) {
      if (!applied.has(migration.version)) apply(migration);
    }
  }

  close() {
    this.db.close();
  }
}
