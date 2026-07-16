import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_SEGMENT_SIZE = 8 * 1024 * 1024;

export class RunEventStore {
  constructor({ database, rootPath, maxSegmentBytes = DEFAULT_SEGMENT_SIZE }) {
    this.database = database;
    this.db = database.db;
    this.rootPath = path.resolve(rootPath);
    this.maxSegmentBytes = maxSegmentBytes;
    this.locks = new Map();
  }

  async append(runId, events) {
    const input = Array.isArray(events) ? events : [events];
    if (!input.length) return [];
    return this.withLock(runId, async () => {
      const last = this.db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM run_event_index WHERE run_id = ?"
      ).get(runId).sequence;
      let segment = this.getOpenSegment(runId);
      const records = [];
      let sequence = last;
      for (const event of input) {
        sequence += 1;
        const normalized = {
          id: event.id || randomUUID(),
          sequence,
          type: String(event.type || "runtime_event"),
          nodeRunId: event.nodeRunId || "",
          payload: event.payload,
          createdAt: event.createdAt || new Date().toISOString(),
        };
        const line = Buffer.from(`${JSON.stringify(normalized)}\n`);
        if (!segment || (segment.sizeBytes > 0 && segment.sizeBytes + line.length > this.maxSegmentBytes)) {
          if (segment) this.closeSegment(segment.id);
          segment = await this.createSegment(runId, sequence);
        }
        const byteOffset = segment.sizeBytes;
        await fs.appendFile(segment.absolutePath, line);
        segment.sizeBytes += line.length;
        segment.lastSequence = sequence;
        segment.eventCount += 1;
        records.push({ event: normalized, segment, byteOffset, byteLength: line.length });
      }
      this.persistAppend(records);
      return records.map((record) => record.event);
    });
  }

  list(runId, { nodeRunId = "", eventType = "", after = 0, limit = 1000 } = {}) {
    const clauses = ["i.run_id = ?", "i.sequence > ?"];
    const parameters = [runId, Math.max(0, Number(after) || 0)];
    if (nodeRunId) {
      clauses.push("i.node_run_id = ?");
      parameters.push(nodeRunId);
    }
    if (eventType) {
      clauses.push("i.event_type = ?");
      parameters.push(eventType);
    }
    parameters.push(Math.min(10_000, Math.max(1, Number(limit) || 1000)));
    const rows = this.db.prepare(`
      SELECT i.*, s.relative_path
      FROM run_event_index i
      JOIN run_event_segments s ON s.id = i.segment_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY i.sequence
      LIMIT ?
    `).all(...parameters);
    return rows.map((row) => this.readIndexedEvent(row));
  }

  getOpenSegment(runId) {
    const row = this.db.prepare(`
      SELECT * FROM run_event_segments
      WHERE run_id = ? AND closed = 0
      ORDER BY first_sequence DESC LIMIT 1
    `).get(runId);
    return row ? mapSegment(row, this.rootPath) : null;
  }

  async createSegment(runId, firstSequence) {
    const id = randomUUID();
    const relativePath = path.posix.join(
      "runs",
      runId,
      `events-${String(firstSequence).padStart(8, "0")}-${id.slice(0, 8)}.jsonl`
    );
    const absolutePath = path.join(this.rootPath, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "", { flag: "wx" });
    return {
      id,
      runId,
      relativePath,
      absolutePath,
      firstSequence,
      lastSequence: firstSequence - 1,
      eventCount: 0,
      sizeBytes: 0,
      createdAt: new Date().toISOString(),
    };
  }

  closeSegment(id) {
    this.db.prepare("UPDATE run_event_segments SET closed = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  persistAppend(records) {
    const upsertSegment = this.db.prepare(`
      INSERT INTO run_event_segments(
        id, run_id, relative_path, first_sequence, last_sequence, event_count,
        size_bytes, closed, created_at, updated_at
      ) VALUES (@id, @runId, @relativePath, @firstSequence, @lastSequence, @eventCount,
        @sizeBytes, 0, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        last_sequence = excluded.last_sequence,
        event_count = excluded.event_count,
        size_bytes = excluded.size_bytes,
        updated_at = excluded.updated_at
    `);
    const insertIndex = this.db.prepare(`
      INSERT INTO run_event_index(
        run_id, sequence, event_id, segment_id, node_run_id, event_type, created_at, byte_offset, byte_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const transaction = this.db.transaction((items) => {
      const segments = new Map(items.map((record) => [record.segment.id, record.segment]));
      const now = new Date().toISOString();
      for (const segment of segments.values()) upsertSegment.run({ ...segment, updatedAt: now });
      for (const record of items) {
        insertIndex.run(
          record.segment.runId,
          record.event.sequence,
          record.event.id,
          record.segment.id,
          record.event.nodeRunId || null,
          record.event.type,
          record.event.createdAt,
          record.byteOffset,
          record.byteLength
        );
      }
    });
    transaction(records);
  }

  readIndexedEvent(row) {
    const absolutePath = path.join(this.rootPath, ...row.relative_path.split("/"));
    const descriptor = fsSync.openSync(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(row.byte_length);
      fsSync.readSync(descriptor, buffer, 0, row.byte_length, row.byte_offset);
      return JSON.parse(buffer.toString("utf8").trimEnd());
    } finally {
      fsSync.closeSync(descriptor);
    }
  }

  async withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

function mapSegment(row, rootPath) {
  return {
    id: row.id,
    runId: row.run_id,
    relativePath: row.relative_path,
    absolutePath: path.join(rootPath, ...row.relative_path.split("/")),
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    eventCount: row.event_count,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}
