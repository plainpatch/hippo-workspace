import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionManager } from "../src/execution-manager.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an execution survives subscriber disconnect and replays missed events in order", async () => {
  const manager = new ExecutionManager({ retentionMs: 1000 });
  let release;
  let executions = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const executor = async (publish) => {
    executions += 1;
    publish({ type: "prepared" });
    await gate;
    publish({ type: "stdout", text: "second" });
    publish({ type: "done" });
  };

  const first = manager.ensure("workspace:run", executor);
  const duplicate = manager.ensure("workspace:run", executor);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);

  const initial = [];
  const unsubscribe = manager.subscribe("workspace:run", (event) => initial.push(event));
  await tick();
  assert.deepEqual(initial.map((event) => event.type), ["prepared"]);
  unsubscribe();

  release();
  await tick();
  await tick();
  const replayed = [];
  manager.subscribe("workspace:run", (event) => replayed.push(event), { after: 1 });
  assert.equal(executions, 1);
  assert.deepEqual(replayed.map((event) => event.type), ["stdout", "done"]);
  assert.deepEqual(replayed.map((event) => event.sequence), [2, 3]);
});

test("an executor that exits without a terminal event is converted to an error", async () => {
  const manager = new ExecutionManager({ retentionMs: 1000 });
  manager.ensure("workspace:missing-terminal", async (publish) => publish({ type: "prepared" }));
  await tick();
  await tick();
  const events = [];
  manager.subscribe("workspace:missing-terminal", (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ["prepared", "error"]);
});
