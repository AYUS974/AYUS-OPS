import express from "express";
import cron from "node-cron";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow,
  getScheduled, getByToken, recordRun, listRuns,
} from "./store.js";
import { runWorkflow, STEP_TYPES } from "./engine.js";

/**
 * Workflow Studio server — REST API + the built-in single-file UI + cron.
 *
 * No auth layer: this is a portable, self-hosted tool meant to run behind your
 * own trust boundary (localhost / a private network). Event workflows are still
 * gated by a per-workflow webhook token. Put it behind a reverse-proxy auth if
 * you expose it publicly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const TRIGGER_TYPES = new Set(["manual", "schedule", "event"]);

function sanitize(body) {
  const name = String(body?.name || "").trim();
  if (!name) throw new Error("name is required");
  if (name.length > 120) throw new Error("name is too long (max 120)");

  const trigger = body?.trigger && typeof body.trigger === "object" ? { ...body.trigger } : { type: "manual" };
  if (!TRIGGER_TYPES.has(trigger.type)) throw new Error(`trigger.type must be one of: ${[...TRIGGER_TYPES].join(", ")}`);
  if (trigger.type === "schedule" && (!trigger.cron || !cron.validate(String(trigger.cron)))) {
    throw new Error("a schedule trigger needs a valid cron expression");
  }
  if (trigger.type === "event" && !trigger.token) trigger.token = crypto.randomBytes(12).toString("hex");

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

// Execute + persist a run in one place (used by manual/schedule/webhook).
async function execute(wf, triggerType, payload) {
  const result = await runWorkflow(wf, { triggerType, payload });
  await recordRun(wf.id, triggerType, result).catch((e) => console.error("[studio] recordRun failed:", e.message));
  return result;
}

// ---------- cron registry ----------
const tasks = new Map();
async function reloadSchedules() {
  for (const t of tasks.values()) t.stop();
  tasks.clear();
  for (const wf of await getScheduled()) {
    const expr = wf.trigger?.cron;
    if (!expr || !cron.validate(expr)) continue;
    tasks.set(wf.id, cron.schedule(expr, async () => {
      const fresh = await getWorkflow(wf.id);
      if (!fresh || !fresh.enabled || fresh.trigger?.type !== "schedule") return;
      console.log(`[studio] cron firing "${fresh.name}"`);
      execute(fresh, "schedule", {}).catch((e) => console.error("[studio] scheduled run failed:", e.message));
    }));
  }
  if (tasks.size) console.log(`[studio] ${tasks.size} scheduled workflow(s) registered`);
}

// ---------- API ----------
app.get("/api/meta", (_req, res) => res.json({ stepTypes: STEP_TYPES, triggerTypes: [...TRIGGER_TYPES] }));

app.get("/api/workflows", async (_req, res) => {
  res.json({ workflows: await listWorkflows() });
});

app.post("/api/workflows", async (req, res) => {
  try {
    const wf = await createWorkflow(sanitize(req.body));
    reloadSchedules();
    res.status(201).json({ ok: true, workflow: wf });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get("/api/workflows/:id", async (req, res) => {
  const wf = await getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: "workflow not found" });
  res.json({ workflow: wf, runs: await listRuns(wf.id) });
});

app.put("/api/workflows/:id", async (req, res) => {
  try {
    const existing = await getWorkflow(req.params.id);
    if (!existing) return res.status(404).json({ error: "workflow not found" });
    const wf = await updateWorkflow(req.params.id, sanitize({ ...existing, ...req.body }));
    reloadSchedules();
    res.json({ ok: true, workflow: wf });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.delete("/api/workflows/:id", async (req, res) => {
  await deleteWorkflow(req.params.id);
  reloadSchedules();
  res.json({ ok: true });
});

app.post("/api/workflows/:id/run", async (req, res) => {
  const wf = await getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: "workflow not found" });
  res.json(await execute(wf, "manual", req.body?.payload || {}));
});

app.get("/api/workflows/:id/runs", async (req, res) => {
  const wf = await getWorkflow(req.params.id);
  if (!wf) return res.status(404).json({ error: "workflow not found" });
  res.json({ runs: await listRuns(wf.id) });
});

// Public webhook — the per-workflow token authorizes this endpoint.
app.post("/hook/:token", async (req, res) => {
  const wf = await getByToken(req.params.token);
  if (!wf) return res.status(404).json({ error: "no active workflow for this token" });
  execute(wf, "event", req.body || {}).catch((e) => console.error("[studio] webhook run failed:", e.message));
  res.status(202).json({ ok: true, workflow: wf.name });
});

const port = process.env.PORT || 4100;
app.listen(port, async () => {
  console.log(`Workflow Studio → http://localhost:${port}`);
  await reloadSchedules();
});
