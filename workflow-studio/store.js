import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Zero-dependency JSON-file persistence. Everything lives under ./data so the
 * whole app (code + its data) is a single portable folder. Two files:
 *   data/workflows.json — the definitions
 *   data/runs.json      — recent run history (capped)
 *
 * Reads are cached in memory; writes are write-through. Single-process, low
 * volume — no locking needed.
 * ponytail: flat JSON files, swap for SQLite/Postgres only if volume demands it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const WF_FILE = path.join(DATA_DIR, "workflows.json");
const RUN_FILE = path.join(DATA_DIR, "runs.json");
const MAX_RUNS = 500; // keep the newest N runs across all workflows

let workflows = null; // in-memory cache
let runs = null;

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function ensure() {
  if (workflows && runs) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  workflows = await readJSON(WF_FILE, []);
  runs = await readJSON(RUN_FILE, []);
}

async function persistWorkflows() {
  await fs.writeFile(WF_FILE, JSON.stringify(workflows, null, 2));
}
async function persistRuns() {
  await fs.writeFile(RUN_FILE, JSON.stringify(runs.slice(0, MAX_RUNS), null, 2));
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

// ---------- workflows ----------

export async function listWorkflows() {
  await ensure();
  return [...workflows].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}

export async function getWorkflow(wfId) {
  await ensure();
  return workflows.find((w) => w.id === wfId) || null;
}

export async function createWorkflow(data) {
  await ensure();
  const wf = {
    id: id(),
    name: data.name,
    description: data.description || null,
    enabled: data.enabled !== false,
    trigger: data.trigger || { type: "manual" },
    steps: data.steps || [],
    last_run_at: null,
    last_status: null,
    run_count: 0,
    created_at: now(),
    updated_at: now(),
  };
  workflows.push(wf);
  await persistWorkflows();
  return wf;
}

export async function updateWorkflow(wfId, patch) {
  await ensure();
  const wf = workflows.find((w) => w.id === wfId);
  if (!wf) return null;
  Object.assign(wf, patch, { updated_at: now() });
  await persistWorkflows();
  return wf;
}

export async function deleteWorkflow(wfId) {
  await ensure();
  workflows = workflows.filter((w) => w.id !== wfId);
  runs = runs.filter((r) => r.workflow_id !== wfId);
  await persistWorkflows();
  await persistRuns();
}

export async function getScheduled() {
  await ensure();
  return workflows.filter((w) => w.enabled && w.trigger?.type === "schedule");
}

export async function getByToken(token) {
  await ensure();
  return workflows.find((w) => w.enabled && w.trigger?.type === "event" && w.trigger?.token === token) || null;
}

// ---------- runs ----------

export async function recordRun(wfId, triggerType, result) {
  await ensure();
  const run = {
    id: id(),
    workflow_id: wfId,
    trigger_type: triggerType,
    status: result.status,
    log: result.log || [],
    error: result.error || null,
    started_at: now(),
  };
  runs.unshift(run);
  const wf = workflows.find((w) => w.id === wfId);
  if (wf) {
    wf.last_run_at = run.started_at;
    wf.last_status = result.status;
    wf.run_count = (wf.run_count || 0) + 1;
    await persistWorkflows();
  }
  await persistRuns();
  return run;
}

export async function listRuns(wfId, limit = 20) {
  await ensure();
  return runs.filter((r) => r.workflow_id === wfId).slice(0, limit);
}
