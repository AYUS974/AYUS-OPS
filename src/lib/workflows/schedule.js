import cron from "node-cron";
import { listScheduledWorkflows, getWorkflow } from "./store.js";
import { runWorkflow } from "./engine.js";

/**
 * Cron registry for schedule-triggered workflows. We keep the set of live
 * node-cron tasks in memory keyed by workflow id, and re-sync it against the DB
 * whenever a workflow is created/edited/deleted (routes call reloadSchedules).
 *
 * On each tick we re-fetch the workflow before running it, so a workflow that
 * was disabled or edited between registration and firing runs its latest form
 * (or not at all).
 */

const tasks = new Map(); // workflow id -> node-cron task

function stopAll() {
  for (const task of tasks.values()) task.stop();
  tasks.clear();
}

/** (Re)build the cron registry from the DB. Safe to call repeatedly. */
export async function reloadSchedules() {
  stopAll();
  let workflows = [];
  try {
    workflows = await listScheduledWorkflows();
  } catch (err) {
    console.error(`[workflows] schedule reload failed: ${err.message}`);
    return;
  }

  for (const wf of workflows) {
    const expr = wf.trigger?.cron;
    if (!expr || !cron.validate(expr)) {
      console.warn(`[workflows] "${wf.name}" has an invalid cron ("${expr}") — skipping`);
      continue;
    }
    const task = cron.schedule(expr, async () => {
      // Re-fetch so we honor edits/disables made since registration.
      const fresh = await getWorkflow(wf.id).catch(() => null);
      if (!fresh || !fresh.enabled || fresh.trigger?.type !== "schedule") return;
      console.log(`[workflows] cron firing "${fresh.name}"`);
      runWorkflow(fresh, { triggerType: "schedule" }).catch((err) =>
        console.error(`[workflows] scheduled run of ${fresh.id} crashed: ${err?.message || err}`)
      );
    });
    tasks.set(wf.id, task);
  }
  if (tasks.size) console.log(`[workflows] ${tasks.size} scheduled workflow(s) registered`);
}
