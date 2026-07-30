import express from "express";
import cron from "node-cron";
import crypto from "node:crypto";
import {
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  listRuns,
} from "./store.js";
import { runWorkflow, STEP_TYPES } from "./engine.js";
import { reloadSchedules } from "./schedule.js";

/**
 * Workflow Automation API. Mounted under the authenticated /api router, so
 * req.user is the signed-in founder and every workflow is scoped to their id.
 *
 *   GET    /api/workflows              → list the founder's workflows
 *   POST   /api/workflows              → create one (+ register cron if scheduled)
 *   GET    /api/workflows/meta         → step palette + trigger types (for the UI)
 *   GET    /api/workflows/:id          → one workflow + its recent runs
 *   PATCH  /api/workflows/:id          → update (name/steps/trigger/enabled)
 *   DELETE /api/workflows/:id          → remove
 *   POST   /api/workflows/:id/run      → run now (manual), returns the run log
 *   GET    /api/workflows/:id/runs     → run history
 *
 * The public webhook that fires "event" workflows lives in src/index.js
 * (/api/workflows/hook/:token) — external callers have no auth session, so the
 * per-workflow token is what authorizes that one endpoint.
 */
export const workflowsRouter = express.Router();

const TRIGGER_TYPES = new Set(["manual", "schedule", "event"]);

/** Validate + normalize a workflow body coming from the client. */
function sanitize(body) {
  const name = String(body?.name || "").trim();
  if (!name) throw new Error("name is required");
  if (name.length > 120) throw new Error("name is too long (max 120)");

  const trigger = body?.trigger && typeof body.trigger === "object" ? { ...body.trigger } : { type: "manual" };
  if (!TRIGGER_TYPES.has(trigger.type)) throw new Error(`trigger.type must be one of: ${[...TRIGGER_TYPES].join(", ")}`);
  if (trigger.type === "schedule") {
    if (!trigger.cron || !cron.validate(String(trigger.cron))) throw new Error("a schedule trigger needs a valid cron expression");
  }
  if (trigger.type === "event" && !trigger.token) {
    trigger.token = crypto.randomBytes(12).toString("hex"); // stable webhook secret
  }

  const rawSteps = Array.isArray(body?.steps) ? body.steps : [];
  if (rawSteps.length > 25) throw new Error("too many steps (max 25)");
  const steps = rawSteps.map((s, i) => {
    if (!STEP_TYPES.includes(s?.type)) throw new Error(`step ${i + 1}: unknown type "${s?.type}"`);
    return {
      id: String(s.id || `s${i + 1}`),
      type: s.type,
      name: String(s.name || s.type).slice(0, 80),
      config: s.config && typeof s.config === "object" ? s.config : {},
    };
  });

  return {
    name,
    description: body?.description ? String(body.description).slice(0, 500) : null,
    enabled: body?.enabled !== false,
    trigger,
    steps,
  };
}

workflowsRouter.get("/", async (req, res) => {
  try {
    res.json({ workflows: await listWorkflows(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Static meta (step palette) — registered before "/:id" so it isn't captured by it.
workflowsRouter.get("/meta", (_req, res) => {
  res.json({ stepTypes: STEP_TYPES, triggerTypes: [...TRIGGER_TYPES] });
});

workflowsRouter.post("/", async (req, res) => {
  try {
    const clean = sanitize(req.body);
    const workflow = await createWorkflow({ ownerId: req.user.id, ...clean });
    reloadSchedules().catch(() => {});
    res.status(201).json({ ok: true, workflow });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

workflowsRouter.get("/:id", async (req, res) => {
  try {
    const workflow = await getWorkflow(req.params.id, req.user.id);
    if (!workflow) return res.status(404).json({ error: "workflow not found" });
    const runs = await listRuns(workflow.id);
    res.json({ workflow, runs });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

workflowsRouter.patch("/:id", async (req, res) => {
  try {
    const existing = await getWorkflow(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: "workflow not found" });
    // Merge so a PATCH can send just { enabled } without re-sending the whole body.
    const clean = sanitize({ ...existing, ...req.body });
    const workflow = await updateWorkflow(req.params.id, req.user.id, clean);
    reloadSchedules().catch(() => {});
    res.json({ ok: true, workflow });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

workflowsRouter.delete("/:id", async (req, res) => {
  try {
    await deleteWorkflow(req.params.id, req.user.id);
    reloadSchedules().catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

workflowsRouter.post("/:id/run", async (req, res) => {
  try {
    const workflow = await getWorkflow(req.params.id, req.user.id);
    if (!workflow) return res.status(404).json({ error: "workflow not found" });
    const result = await runWorkflow(workflow, { triggerType: "manual", payload: req.body?.payload || {} });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

workflowsRouter.get("/:id/runs", async (req, res) => {
  try {
    const workflow = await getWorkflow(req.params.id, req.user.id);
    if (!workflow) return res.status(404).json({ error: "workflow not found" });
    res.json({ runs: await listRuns(workflow.id) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
