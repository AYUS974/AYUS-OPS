import express from "express";
import { createMission, listMissions, getMission, updateMission, listTasks, listEvents } from "./store.js";
import { runMission, isRunning } from "./engine.js";

/**
 * Mission API. Mounted under the authenticated /api router, so req.user is the
 * signed-in founder and every mission is scoped to req.user.id (multi-tenant).
 *
 *   POST /api/missions           { objective }  → creates + kicks off a mission
 *   GET  /api/missions                          → the founder's recent missions
 *   GET  /api/missions/:id                      → one mission + tasks + A2A timeline
 *   POST /api/missions/:id/stop                 → ask a live run to abort
 *   POST /api/missions/:id/resume               → resume a stopped / retry a failed run
 */
export const missionsRouter = express.Router();

const STOPPABLE = new Set(["queued", "scoping", "planning", "running", "assembling", "reviewing", "revising", "retrying"]);
const RESUMABLE = new Set(["failed", "stopped", "stopping"]);

missionsRouter.post("/", async (req, res) => {
  const objective = String(req.body?.objective || "").trim();
  if (!objective) return res.status(400).json({ error: "objective is required" });
  if (objective.length > 2000) return res.status(400).json({ error: "objective is too long (max 2000 chars)" });

  try {
    const mission = await createMission({ ownerId: req.user.id, objective });

    // Run the pipeline in the background — it makes many sequential LLM calls and
    // can take a minute+. runMission catches its own errors and records them on
    // the mission row, so the dashboard polls /missions/:id to watch it progress.
    runMission(mission).catch((err) =>
      console.error(`[missions] runMission ${mission.id} crashed:`, err?.message || err)
    );

    res.status(202).json({ ok: true, mission });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

missionsRouter.get("/", async (req, res) => {
  try {
    res.json({ missions: await listMissions(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

missionsRouter.get("/:id", async (req, res) => {
  try {
    const mission = await getMission(req.params.id, req.user.id);
    if (!mission) return res.status(404).json({ error: "mission not found" });
    const [tasks, events] = await Promise.all([listTasks(mission.id), listEvents(mission.id)]);
    res.json({ mission, tasks, events });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Stop a mission. If its pipeline is live in this process, flip it to "stopping"
// and let runMission abort at its next checkpoint; if it's orphaned (e.g. left
// over from a restart), there's no loop to catch the flag, so mark it stopped now.
missionsRouter.post("/:id/stop", async (req, res) => {
  try {
    const mission = await getMission(req.params.id, req.user.id);
    if (!mission) return res.status(404).json({ error: "mission not found" });
    if (!STOPPABLE.has(mission.status)) return res.status(400).json({ error: `mission is ${mission.status}, nothing to stop` });
    await updateMission(mission.id, isRunning(mission.id) ? { status: "stopping" } : { status: "stopped" });
    res.status(202).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Resume a stopped mission / retry a failed one. Both reuse the existing scope
// and completed task outputs (resume mode), so finished work isn't redone.
missionsRouter.post("/:id/resume", async (req, res) => {
  try {
    const mission = await getMission(req.params.id, req.user.id);
    if (!mission) return res.status(404).json({ error: "mission not found" });
    if (!RESUMABLE.has(mission.status)) return res.status(400).json({ error: `can't resume a ${mission.status} mission` });
    if (isRunning(mission.id)) return res.status(409).json({ error: "mission is already running" });

    await updateMission(mission.id, { status: "queued", error: null });
    const fresh = await getMission(mission.id, req.user.id);
    runMission(fresh, { resume: true }).catch((err) =>
      console.error(`[missions] resume ${mission.id} crashed:`, err?.message || err)
    );
    res.status(202).json({ ok: true, mission: fresh });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});
