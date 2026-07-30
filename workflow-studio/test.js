import assert from "node:assert/strict";
import { runWorkflow, resolve } from "./engine.js";

/**
 * Self-check for the workflow engine — the smallest thing that fails if step
 * threading, templating, or the condition-gate breaks. Runs fully offline.
 *   node test.js
 */

// 1) template resolution: a solo ref returns the raw value; inline refs stringify.
const ctx = { steps: { s1: { output: { n: 5 } } }, trigger: { payload: { name: "Ada" } }, vars: {} };
assert.deepEqual(resolve("{{steps.s1.output}}", ctx), { n: 5 }, "solo ref should return raw value");
assert.equal(resolve("hi {{trigger.payload.name}}!", ctx), "hi Ada!", "inline ref should splice");
assert.equal(resolve("{{missing.path}}", ctx), "", "missing ref resolves to empty string");

// 2) a real chain: set → template (reads var + trigger) → log → delay, threaded end to end.
const chain = {
  steps: [
    { id: "a", type: "set", name: "set greeting", config: { key: "greeting", value: "Hello" } },
    { id: "b", type: "template", name: "compose", config: { text: "{{vars.greeting}}, {{trigger.payload.name}}" } },
    { id: "c", type: "log", name: "log it", config: { message: "{{steps.b.output}}" } },
    { id: "d", type: "delay", name: "wait", config: { seconds: 0 } },
  ],
};
const r1 = await runWorkflow(chain, { triggerType: "manual", payload: { name: "Grace" } });
assert.equal(r1.status, "ok", "chain should succeed");
assert.equal(r1.log.length, 4, "every step should log");
assert.ok(r1.log.every((l) => l.status === "ok"), "no step should error");
assert.equal(r1.log[1].message, "Hello, Grace", "template should read var + payload");

// 3) condition gate: a false comparison stops the run cleanly (status "stopped").
const gated = {
  steps: [
    { id: "a", type: "template", name: "value", config: { text: "no" } },
    { id: "b", type: "condition", name: "gate", config: { left: "{{steps.a.output}}", op: "==", right: "yes" } },
    { id: "c", type: "log", name: "should not run", config: { message: "reached" } },
  ],
};
const r2 = await runWorkflow(gated);
assert.equal(r2.status, "stopped", "failed condition should stop the run");
assert.equal(r2.log.length, 2, "steps after a failed gate should not run");

// 4) unknown step type is an error, not a crash.
const bad = await runWorkflow({ steps: [{ id: "x", type: "nope", config: {} }] });
assert.equal(bad.status, "error");

// 5) empty workflow is an error.
const empty = await runWorkflow({ steps: [] });
assert.equal(empty.status, "error");

console.log("✓ all engine self-checks passed");
