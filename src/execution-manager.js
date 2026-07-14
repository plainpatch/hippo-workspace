export class ExecutionManager {
  constructor({ retentionMs = 10 * 60 * 1000, maxEvents = 2000 } = {}) {
    this.retentionMs = retentionMs;
    this.maxEvents = maxEvents;
    this.records = new Map();
  }

  ensure(key, executor, { restartCompleted = false } = {}) {
    const existing = this.records.get(key);
    if (existing && (!restartCompleted || existing.status === "running")) {
      return { record: existing, created: false };
    }
    if (existing) {
      clearTimeout(existing.cleanupTimer);
      this.records.delete(key);
    }

    const record = {
      key,
      events: [],
      nextSequence: 1,
      subscribers: new Set(),
      status: "running",
      createdAt: new Date().toISOString(),
      completedAt: "",
      cleanupTimer: undefined,
    };
    this.records.set(key, record);

    queueMicrotask(async () => {
      let terminalPublished = false;
      const publish = (event) => {
        if (["done", "error", "cancelled"].includes(event?.type)) terminalPublished = true;
        this.publish(key, event);
      };
      try {
        await executor(publish);
        if (!terminalPublished) publish({ type: "error", error: "Execution ended without a terminal event." });
      } catch (error) {
        if (!terminalPublished) {
          publish({
            type: error?.status === 499 || error?.details?.cancelled ? "cancelled" : "error",
            error: error?.message || "Execution failed.",
            details: error?.details || error?.issues,
          });
        }
      } finally {
        this.finish(key);
      }
    });
    return { record, created: true };
  }

  publish(key, event) {
    const record = this.records.get(key);
    if (!record || !event) return;
    const envelope = { ...event, sequence: record.nextSequence++ };
    record.events.push(envelope);
    if (record.events.length > this.maxEvents) record.events.splice(0, record.events.length - this.maxEvents);
    for (const subscriber of record.subscribers) subscriber(envelope);
  }

  subscribe(key, listener, { after = 0 } = {}) {
    const record = this.records.get(key);
    if (!record) return undefined;
    for (const event of record.events) {
      if (event.sequence > after) listener(event);
    }
    if (record.status === "running") record.subscribers.add(listener);
    return () => record.subscribers.delete(listener);
  }

  get(key) {
    return this.records.get(key);
  }

  finish(key) {
    const record = this.records.get(key);
    if (!record || record.status !== "running") return;
    record.status = "completed";
    record.completedAt = new Date().toISOString();
    record.subscribers.clear();
    record.cleanupTimer = setTimeout(() => this.records.delete(key), this.retentionMs);
    record.cleanupTimer.unref?.();
  }
}
