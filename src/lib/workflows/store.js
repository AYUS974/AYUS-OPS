import { db } from "../supabase.js";

/**
 * Persistence for Workflow Automation. All access is server-side via the
 * service-role client, scoped to owner_id (the signed-in founder) exactly like
 * the mission store.
 */

// ---------- Workflows ----------

export async function createWorkflow({ ownerId, name, description, trigger, steps, enabled = true }) {
  const { data, error } = await db
    .from("workflows")
    .insert({
      owner_id: ownerId || null,
      name,
      description: description || null,
      enabled,
      trigger: trigger || { type: "manual" },
      steps: steps || [],
    })
    .select("*")
    .single();
  if (error) throw new Error(`createWorkflow: ${error.message}`);
  return data;
}

export async function updateWorkflow(id, ownerId, patch) {
  let q = db
    .from("workflows")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (ownerId) q = q.eq("owner_id", ownerId);
  const { data, error } = await q.select("*").maybeSingle();
  if (error) throw new Error(`updateWorkflow: ${error.message}`);
  return data;
}

export async function deleteWorkflow(id, ownerId) {
  let q = db.from("workflows").delete().eq("id", id);
  if (ownerId) q = q.eq("owner_id", ownerId);
  const { error } = await q;
  if (error) throw new Error(`deleteWorkflow: ${error.message}`);
}

export async function getWorkflow(id, ownerId) {
  let q = db.from("workflows").select("*").eq("id", id);
  if (ownerId) q = q.eq("owner_id", ownerId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`getWorkflow: ${error.message}`);
  return data;
}

export async function listWorkflows(ownerId, limit = 100) {
  let q = db.from("workflows").select("*").order("created_at", { ascending: false }).limit(limit);
  if (ownerId) q = q.eq("owner_id", ownerId);
  const { data, error } = await q;
  if (error) throw new Error(`listWorkflows: ${error.message}`);
  return data || [];
}

/** Every enabled workflow with a schedule trigger — used to (re)register cron jobs. */
export async function listScheduledWorkflows() {
  const { data, error } = await db
    .from("workflows")
    .select("*")
    .eq("enabled", true)
    .eq("trigger->>type", "schedule");
  if (error) throw new Error(`listScheduledWorkflows: ${error.message}`);
  return data || [];
}

/** Look up an enabled event-triggered workflow by its webhook token. */
export async function getWorkflowByEventToken(token) {
  const { data, error } = await db
    .from("workflows")
    .select("*")
    .eq("enabled", true)
    .eq("trigger->>type", "event")
    .eq("trigger->>token", token)
    .maybeSingle();
  if (error) throw new Error(`getWorkflowByEventToken: ${error.message}`);
  return data;
}

// ---------- Runs ----------

export async function startRun({ workflowId, ownerId, triggerType }) {
  const { data, error } = await db
    .from("workflow_runs")
    .insert({ workflow_id: workflowId, owner_id: ownerId || null, trigger_type: triggerType, status: "running" })
    .select("*")
    .single();
  if (error) throw new Error(`startRun: ${error.message}`);
  return data;
}

export async function finishRun(id, { status, log, error }) {
  const { error: dbErr } = await db
    .from("workflow_runs")
    .update({ status, log: log || [], error: error || null, finished_at: new Date().toISOString() })
    .eq("id", id);
  if (dbErr) console.error(`[workflows] finishRun failed: ${dbErr.message}`);
}

export async function listRuns(workflowId, limit = 20) {
  const { data, error } = await db
    .from("workflow_runs")
    .select("*")
    .eq("workflow_id", workflowId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listRuns: ${error.message}`);
  return data || [];
}
