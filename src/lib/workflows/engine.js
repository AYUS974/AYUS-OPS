import { db } from "../supabase.js";
import { llmJSON } from "../llm.js";
import { notify } from "../notify.js";
import { createMission } from "../missions/store.js";
import { runMission } from "../missions/engine.js";
import { startRun, finishRun, updateWorkflow } from "./store.js";

/**
 * The Workflow engine. Runs a workflow's steps in order, threading each step's
 * output into a shared context that later steps template against with
 * {{steps.<id>.output}} / {{trigger.payload.x}} syntax.
 *
 * Every run is bounded and best-effort: a failing step records its error and
 * stops the run (like a real automation tool — no silent half-success), but the
 * engine itself never throws into the caller. The full per-step log is persisted
 * on the workflow_runs row so the UI can replay exactly what happened.
 */

const MAX_STEPS = 25; // a single workflow can't fan out unbounded
const HTTP_TIMEOUT_MS = 20000;
const MAX_DELAY_S = 300; // a delay step can pause at most 5 min

// ---------- template resolution ----------

/** Walk a dotted path (a.b.c) into an object; undefined if any hop is missing. */
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Resolve {{ expr }} references against the run context. If a string is exactly
 * one reference ("{{steps.s1.output}}"), the raw value is returned so non-string
 * outputs (objects, numbers) survive; otherwise references are stringified and
 * spliced into the surrounding text.
 */
function resolve(value, ctx) {
  if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)]));
  }
  if (typeof value !== "string") return value;

  const solo = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (solo) {
    const v = getPath(ctx, solo[1]);
    return v === undefined ? "" : v;
  }
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const v = getPath(ctx, expr.trim());
    if (v === undefined) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

// ---------- step handlers ----------
// Each returns the value stored at ctx.steps[stepId].output.

const HANDLERS = {
  async create_mission(cfg, ctx, { ownerId }) {
    const objective = String(resolve(cfg.objective, ctx) || "").trim();
    if (!objective) throw new Error("create_mission needs an objective");
    const mission = await createMission({ ownerId, objective });
    // Run the org pipeline in the background — it makes many LLM calls and can
    // take a minute+. The workflow step completes as soon as the mission is
    // queued; the mission dashboard tracks it from there.
    runMission(mission).catch((err) =>
      console.error(`[workflow] mission ${mission.id} crashed:`, err?.message || err)
    );
    return { mission_id: mission.id, objective };
  },

  async llm(cfg, ctx) {
    const prompt = String(resolve(cfg.prompt, ctx) || "").trim();
    if (!prompt) throw new Error("llm step needs a prompt");
    const res = await llmJSON({
      system: cfg.system ? String(resolve(cfg.system, ctx)) : "You are a precise automation worker. Do exactly what the prompt asks.",
      prompt,
      schema: { type: "object", properties: { output: { type: "string" } }, required: ["output"] },
      maxTokens: Math.min(Number(cfg.maxTokens) || 1500, 4000),
    });
    return res.output;
  },

  async propose_action(cfg, ctx) {
    const payload = resolve(cfg.payload || {}, ctx);
    const { data, error } = await db
      .from("pending_actions")
      .insert({
        agent: "workflow",
        type: String(cfg.type || "manual_task"),
        title: String(resolve(cfg.title, ctx) || "Workflow proposal"),
        summary: resolve(cfg.summary, ctx) || null,
        payload: payload && typeof payload === "object" ? payload : {},
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { action_id: data.id };
  },

  async notify(cfg, ctx) {
    const message = String(resolve(cfg.message, ctx) || "").trim();
    if (!message) throw new Error("notify step needs a message");
    const r = await notify(message, { urgent: Boolean(cfg.urgent) });
    return { sent: r.ok, channel: r.channel };
  },

  async http(cfg, ctx) {
    const url = String(resolve(cfg.url, ctx) || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("http step needs an http(s) url");
    const method = String(cfg.method || "GET").toUpperCase();
    const headers = resolve(cfg.headers || {}, ctx);
    const rawBody = resolve(cfg.body, ctx);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method,
        headers: headers && typeof headers === "object" ? headers : undefined,
        body: method === "GET" || method === "HEAD" || rawBody == null
          ? undefined
          : typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody),
        signal: ac.signal,
      });
      const text = (await r.text()).slice(0, 20000);
      let body = text;
      try { body = JSON.parse(text); } catch { /* keep as text */ }
      return { status: r.status, ok: r.ok, body };
    } finally {
      clearTimeout(timer);
    }
  },

  async delay(cfg) {
    const seconds = Math.min(Math.max(Number(cfg.seconds) || 0, 0), MAX_DELAY_S);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return { waited: seconds };
  },
};

export const STEP_TYPES = Object.keys(HANDLERS);

// ---------- runner ----------

/**
 * Execute one workflow to completion. Never throws. Persists a workflow_runs
 * row with the full step log and updates the workflow's last_status/run_count.
 *
 * @param {object} workflow - the workflows row
 * @param {object} [opts]
 * @param {string} [opts.triggerType] - manual | schedule | event
 * @param {object} [opts.payload] - data handed to the trigger (event/webhook body)
 */
export async function runWorkflow(workflow, { triggerType = "manual", payload = {} } = {}) {
  const ownerId = workflow.owner_id || null;
  const steps = Array.isArray(workflow.steps) ? workflow.steps.slice(0, MAX_STEPS) : [];
  const ctx = { trigger: { type: triggerType, payload }, steps: {}, now: new Date().toISOString() };
  const log = [];

  let run;
  try {
    run = await startRun({ workflowId: workflow.id, ownerId, triggerType });
  } catch (err) {
    console.error(`[workflow ${workflow.id}] could not start run: ${err.message}`);
    return { ok: false, error: err.message };
  }
  await updateWorkflow(workflow.id, ownerId, { last_status: "running", last_run_at: new Date().toISOString() }).catch(() => {});

  let status = "ok";
  let runError = null;

  for (const [i, step] of steps.entries()) {
    const type = step?.type;
    const label = step?.name || type || `step ${i + 1}`;
    const t0 = Date.now();
    const handler = HANDLERS[type];
    if (!handler) {
      log.push({ step: label, type, status: "error", message: `unknown step type "${type}"`, ms: 0 });
      status = "error";
      runError = `unknown step type "${type}"`;
      break;
    }
    try {
      const output = await handler(step.config || {}, ctx, { ownerId, workflow });
      ctx.steps[step.id || `s${i + 1}`] = { output };
      log.push({
        step: label,
        type,
        status: "ok",
        message: summarize(output),
        ms: Date.now() - t0,
      });
    } catch (err) {
      log.push({ step: label, type, status: "error", message: String(err?.message || err), ms: Date.now() - t0 });
      status = "error";
      runError = String(err?.message || err);
      break; // stop the chain on first failure, like a real automation run
    }
  }

  if (!steps.length) {
    status = "error";
    runError = "workflow has no steps";
    log.push({ step: "—", type: null, status: "error", message: "workflow has no steps", ms: 0 });
  }

  await finishRun(run.id, { status, log, error: runError });
  await updateWorkflow(workflow.id, ownerId, {
    last_status: status,
    run_count: (workflow.run_count || 0) + 1,
  }).catch(() => {});

  return { ok: status === "ok", runId: run.id, log, error: runError };
}

/** A short, human-readable one-liner for a step's output in the run log. */
function summarize(output) {
  if (output == null) return "";
  if (typeof output === "string") return output.length > 160 ? output.slice(0, 157) + "…" : output;
  const s = JSON.stringify(output);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}
