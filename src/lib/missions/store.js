import { db } from "../supabase.js";

/**
 * Persistence + the A2A event bus for missions.
 *
 * Every state change and every agent-to-agent message goes through here, so the
 * mission timeline in the dashboard is an exact, replayable record of what the
 * org did. All access is via the service-role client (server-side only).
 */

// ---------- Missions ----------

export async function createMission({ ownerId, objective }) {
  const { data, error } = await db
    .from("missions")
    .insert({ owner_id: ownerId || null, objective, status: "queued", stage: "Queued" })
    .select("*")
    .single();
  if (error) throw new Error(`createMission: ${error.message}`);
  return data;
}

export async function updateMission(id, patch) {
  const { data, error } = await db
    .from("missions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`updateMission: ${error.message}`);
  return data;
}

export async function getMission(id, ownerId) {
  let q = db.from("missions").select("*").eq("id", id);
  if (ownerId) q = q.eq("owner_id", ownerId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`getMission: ${error.message}`);
  return data;
}

export async function listMissions(ownerId, limit = 25) {
  let q = db.from("missions").select("*").order("created_at", { ascending: false }).limit(limit);
  if (ownerId) q = q.eq("owner_id", ownerId);
  const { data, error } = await q;
  if (error) throw new Error(`listMissions: ${error.message}`);
  return data || [];
}

/**
 * Missions left in a non-terminal state — i.e. that were mid-flight when the
 * process died (nodemon reload / crash / deploy). runMission only lives in
 * memory, so without this they'd be orphaned in "running" forever. Bounded to
 * recent rows so a restart can't resurrect an ancient stuck mission.
 */
const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);
export async function listActiveMissions(maxAgeMin = 60) {
  const since = new Date(Date.now() - maxAgeMin * 60000).toISOString();
  const { data, error } = await db
    .from("missions")
    .select("*")
    .gte("updated_at", since)
    .order("updated_at", { ascending: true });
  if (error) throw new Error(`listActiveMissions: ${error.message}`);
  return (data || []).filter((m) => !TERMINAL_STATUSES.has(m.status));
}

// ---------- Tasks ----------

/** Bulk-insert the planner's decomposed tasks. `tasks` are already validated. */
export async function createTasks(missionId, ownerId, tasks) {
  const rows = tasks.map((t, i) => ({
    mission_id: missionId,
    owner_id: ownerId || null,
    task_key: t.task_key,
    title: t.title,
    description: t.description || "",
    role: t.role,
    depends_on: t.depends_on || [],
    position: i,
    status: "pending",
  }));
  const { data, error } = await db.from("mission_tasks").insert(rows).select("*");
  if (error) throw new Error(`createTasks: ${error.message}`);
  return data || [];
}

export async function updateTask(id, patch) {
  const { error } = await db
    .from("mission_tasks")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`updateTask: ${error.message}`);
}

export async function listTasks(missionId) {
  const { data, error } = await db
    .from("mission_tasks")
    .select("*")
    .eq("mission_id", missionId)
    .order("position", { ascending: true });
  if (error) throw new Error(`listTasks: ${error.message}`);
  return data || [];
}

// ---------- Events (A2A bus + audit log) ----------

/**
 * Record one entry on the mission timeline. Never throws — a missed log line
 * must never abort the mission it's describing.
 */
export async function emitEvent(missionId, ownerId, { kind = "message", from, to, message, data }) {
  try {
    await db.from("mission_events").insert({
      mission_id: missionId,
      owner_id: ownerId || null,
      kind,
      from_agent: from || null,
      to_agent: to || null,
      message: message || null,
      data: data || {},
    });
  } catch (err) {
    console.error(`[mission ${missionId}] event log failed: ${err.message || err}`);
  }
}

export async function listEvents(missionId) {
  const { data, error } = await db
    .from("mission_events")
    .select("*")
    .eq("mission_id", missionId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listEvents: ${error.message}`);
  return data || [];
}
