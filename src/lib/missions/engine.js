import { llmJSON } from "../llm.js";
import { ROLES, resolveSpecialist, specialistCatalogue } from "./roles.js";
import { gatherSources, groundingPreface } from "./sources.js";
import {
  getMission,
  updateMission,
  createTasks,
  updateTask,
  listTasks,
  listActiveMissions,
  emitEvent,
} from "./store.js";

/**
 * The Mission Engine — AYUS's autonomous-org pipeline.
 *
 *   founder objective
 *     → CEO scopes it (success criteria + deliverable type)
 *     → Planner decomposes into specialist tasks with dependencies
 *     → Specialists execute in dependency order, passing artifacts A2A
 *     → CEO assembles a draft deliverable
 *     → QA scores it, Reviewer validates it
 *     → one revision pass if rejected
 *     → CEO delivers the final artifact + operator debrief
 *
 * Every step is persisted (missions/mission_tasks/mission_events) so the
 * dashboard can show the org working in real time, and replay it afterwards.
 *
 * Bounded by design: at most MAX_TASKS specialists and ONE revision loop, so a
 * single mission can't fan out into unbounded LLM spend.
 */

const MAX_TASKS = 6;
const QA_PASS = 7; // score (1-10) at or above which a deliverable ships without revision
const MAX_MISSION_ATTEMPTS = 2; // 1 initial run + 1 automatic retry on failure
// Cap how many specialists hit the LLM at once. A wide planner wave firing 6
// large calls simultaneously trips free-tier limits (Groq's per-minute token
// budget, or GLM's account concurrency) — 2 keeps us under them while still
// overlapping work. Dependencies are still honored across waves.
const WAVE_CONCURRENCY = 2;

// In-memory registry of missions whose pipeline is actively running in THIS
// process. Lets the stop endpoint tell "cancel a live run" (cooperative abort
// at the next checkpoint) apart from "stop an orphaned row" (mark stopped now).
const RUNNING = new Set();
export function isRunning(id) {
  return RUNNING.has(id);
}

// Thrown by the in-pipeline checkpoint when the founder asked to stop. Carries a
// flag so the catch block records "stopped" (not "failed") and skips auto-retry.
class MissionStopped extends Error {
  constructor() {
    super("Mission stopped by founder");
    this.stopped = true;
  }
}

// ---------- LLM schemas ----------

const SCOPE_SCHEMA = {
  type: "object",
  properties: {
    understanding: { type: "string", description: "One-paragraph restatement of what the founder wants" },
    deliverable_type: { type: "string", description: "e.g. research_report | linkedin_post | email | plan | code | design" },
    success_criteria: { type: "array", items: { type: "string" }, description: "3-5 concrete 'done' checks" },
  },
  required: ["understanding", "deliverable_type", "success_criteria"],
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task_key: { type: "string", description: "stable slug like t1, t2" },
          title: { type: "string" },
          description: { type: "string", description: "exactly what this specialist must produce" },
          role: { type: "string", description: "one specialist role id from the catalogue" },
          depends_on: { type: "array", items: { type: "string" }, description: "task_keys that must finish first" },
        },
        required: ["task_key", "title", "description", "role", "depends_on"],
      },
    },
  },
  required: ["tasks"],
};

const WORK_SCHEMA = {
  type: "object",
  properties: { output: { type: "string", description: "the finished work product, in markdown" } },
  required: ["output"],
};

// Code deliverables ship as real files, never as one giant markdown string.
// Splitting the work into a files array keeps each string small (so it survives
// the model's output-token cap instead of truncating mid-string) and lets us
// assemble the project deterministically instead of letting an LLM re-flatten it
// into ASCII-art placeholders.
const FILES_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      description: "Every file you create or change, each with its COMPLETE contents.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "relative path, e.g. index.html, style.css, script.js" },
          contents: { type: "string", description: "the COMPLETE file contents — never truncated, no placeholders, no ASCII-art mockups, no markdown fences" },
        },
        required: ["path", "contents"],
      },
    },
    notes: { type: "string", description: "optional short note on what you built / how it fits together" },
  },
  required: ["files"],
};

// A build is anything the CEO scoped as runnable software. Detected from the
// deliverable_type (which the CEO reliably sets to code/app/web/game/etc), so a
// "research the app market" objective stays in the prose path.
const CODE_TYPES = /\b(code|app|web|website|site|game|html|css|js|javascript|frontend|front-end|ui|component|script|tool|landing[\s-]?page|dashboard|prototype|widget|extension)\b/i;
function isCodeDeliverable(deliverableType = "") {
  return CODE_TYPES.test(deliverableType);
}

const ASSEMBLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    deliverable: { type: "string", description: "the final deliverable, publish-ready, in markdown" },
    debrief: { type: "string", description: "2-3 sentence operator debrief for the founder" },
  },
  required: ["title", "deliverable", "debrief"],
};

const QA_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 10 },
    passed: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
    feedback: { type: "string" },
  },
  required: ["score", "passed", "issues", "feedback"],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    verdict: { type: "string" },
    required_changes: { type: "array", items: { type: "string" } },
  },
  required: ["approved", "verdict", "required_changes"],
};

// ---------- Public entrypoint ----------

/**
 * Run a mission to completion. Never throws. Registers the mission as RUNNING
 * for the duration (so the stop endpoint can tell a live run from an orphan),
 * then delegates to runAttempt, which owns the pipeline, cooperative-stop, and
 * one bounded auto-retry.
 *
 * @param {object} mission - the missions row (id, owner_id, objective, ...)
 * @param {object} [opts]
 * @param {boolean} [opts.resume] - reuse the existing scope + completed tasks
 *        instead of starting over (used by resume/retry and restart-recovery).
 */
export async function runMission(mission, opts = {}) {
  const id = mission.id;
  RUNNING.add(id);
  try {
    return await runAttempt(mission, opts);
  } finally {
    RUNNING.delete(id);
  }
}

/**
 * On boot, re-pick-up any mission that was mid-flight when the previous process
 * died (nodemon reload / crash / deploy). Without this they sit in "running"
 * forever — which is exactly the "stuck in queued/running" symptom. Resumes
 * reuse completed task outputs, so recovery is cheap.
 */
export async function recoverMissions() {
  let stuck;
  try {
    stuck = await listActiveMissions();
  } catch (err) {
    console.error(`[missions] recovery scan failed: ${err?.message || err}`);
    return;
  }
  if (!stuck.length) return;
  console.log(`[missions] recovering ${stuck.length} interrupted mission(s)…`);
  for (const m of stuck) {
    // A mission the founder had asked to stop should settle as stopped, not run.
    if (m.status === "stopping") {
      await updateMission(m.id, { status: "stopped" }).catch(() => {});
      continue;
    }
    runMission(m, { resume: true }).catch((err) =>
      console.error(`[missions] recovery of ${m.id} crashed: ${err?.message || err}`)
    );
  }
}

async function runAttempt(mission, { attempt = 1, resume = false } = {}) {
  const { id, owner_id: owner, objective } = mission;
  const ev = (e) => emitEvent(id, owner, e);

  // Track the real stage we're in, so a failure/stop records exactly WHERE it
  // happened (not a generic "Failed"). This drives the honest pipeline tracker.
  let currentStage = mission.stage || "Queued";

  // Cooperative cancellation: the stop endpoint flips the row to "stopping";
  // we check it at every stage boundary and abort cleanly if asked.
  const checkpoint = async () => {
    const cur = await getMission(id).catch(() => null);
    if (cur && (cur.status === "stopping" || cur.status === "stopped")) throw new MissionStopped();
  };
  const setStage = async (status, label, extra = {}) => {
    await checkpoint(); // never advance past a stop request
    currentStage = label;
    await updateMission(id, { status, stage: label, ...extra });
  };

  try {
    await ev({
      kind: "status",
      from: "founder",
      to: "ceo",
      message: resume ? `Resuming mission: "${objective}"` : `Mission received: "${objective}"`,
    });

    // 0) Ground the run in the founder's own links. Any URL in the objective is
    //    fetched live and handed to every agent as authoritative context — this
    //    is what stops "research X (here's the site)" from drifting onto some
    //    other same-named entity the model half-remembers.
    const sources = await gatherSources(objective);
    const grounding = groundingPreface(sources.block);
    if (sources.urls.length) {
      if (sources.fetched.length) {
        await ev({
          kind: "artifact",
          from: "researcher",
          to: "ceo",
          message: `Read ${sources.fetched.length} source(s) from the objective: ${sources.fetched.join(", ")}`,
        });
      }
      if (sources.failed.length) {
        await ev({
          kind: "error",
          from: "researcher",
          to: "ceo",
          message: `Couldn't read ${sources.failed.length} link(s): ${sources.failed.map((f) => `${f.url} (${f.error})`).join("; ")}`,
        });
      }
    }

    // 1) CEO scopes the objective (reused as-is when resuming an already-scoped run).
    let scope = resume && mission.plan?.success_criteria?.length ? mission.plan : null;
    if (!scope) {
      await setStage("scoping", "Scope");
      scope = await ceoScope(objective, grounding);
      await updateMission(id, { deliverable_type: scope.deliverable_type, plan: scope });
      await ev({
        kind: "message",
        from: "ceo",
        to: "planner",
        message: `Scoped → ${scope.deliverable_type}. ${scope.understanding}`,
        data: { success_criteria: scope.success_criteria },
      });
    }

    // Is this a build? A code/app objective ships as real files through a
    // files-based path (no single-giant-string truncation, no markdown
    // flattening), so working code survives all the way to the deliverable.
    const codeMode = isCodeDeliverable(scope.deliverable_type);

    // 2) Planner decomposes the work (reuse the existing task list when resuming).
    let taskRows = resume ? await listTasks(id) : [];
    if (!taskRows.length) {
      await setStage("planning", "Planning");
      const planned = await planner(objective, scope, grounding);
      taskRows = await createTasks(id, owner, planned);
      for (const t of taskRows) {
        await ev({
          kind: "delegation",
          from: "planner",
          to: t.role,
          message: `Assigned "${t.title}" to ${ROLES[t.role]?.name || t.role}`,
          data: { task_key: t.task_key, depends_on: t.depends_on },
        });
      }
    }

    // 3) Specialists execute in dependency order, passing artifacts downstream.
    //    Already-completed tasks are reused; only pending/failed ones re-run.
    await setStage("running", "Specialists working");
    const outputs = await runTasks({ missionId: id, owner, objective, scope, grounding, tasks: taskRows, ev, checkpoint, codeMode });

    // 4) CEO assembles a draft deliverable from the specialist artifacts. Code
    //    is merged deterministically (collect files, dedupe, ensure an entry
    //    point) so the working software is never re-flattened by an LLM.
    await setStage("assembling", "CEO assembling");
    let assembled = codeMode ? assembleCode(objective, scope, outputs) : await ceoAssemble(objective, scope, outputs);
    await ev({ kind: "artifact", from: "ceo", to: "qa", message: `Assembled draft: "${assembled.title}"` });

    // 5) QA scores it; 6) Reviewer validates it. For builds, QA grades the real
    //    concatenated code, not a prose summary of it.
    await setStage("reviewing", "QA + Review");
    const qaTarget = codeMode ? filesToReviewText(assembled.files) : assembled.deliverable;
    let qa = await qaReview(objective, scope, qaTarget);
    await ev({
      kind: "message",
      from: "qa",
      to: "ceo",
      message: `QA score ${qa.score}/10 — ${qa.passed ? "pass" : "needs work"}`,
      data: { issues: qa.issues },
    });
    let review = await seniorReview(objective, scope, qaTarget, qa);
    await ev({
      kind: "message",
      from: "reviewer",
      to: "ceo",
      message: `Reviewer ${review.approved ? "approved" : "requested changes"} — ${review.verdict}`,
      data: { required_changes: review.required_changes },
    });

    // 7) One bounded revision pass if either gate failed.
    const needsRevision = !review.approved || !qa.passed || qa.score < QA_PASS;
    if (needsRevision) {
      await setStage("revising", "Revising");
      const changes = [...(review.required_changes || []), ...(qa.issues || [])];
      await ev({ kind: "delegation", from: "ceo", to: codeMode ? "engineer" : "writer", message: `Revising against ${changes.length} note(s)` });
      // The deliverable already cleared assembly + a first QA pass — the revision
      // is a polish pass, not the build itself. If it throws (e.g. a provider
      // rate-limit even after retries), DON'T fail the whole mission and throw a
      // working build away; ship the pre-revision draft honestly instead.
      const preRevision = assembled;
      try {
        assembled = codeMode
          ? await codeRevise(objective, scope, assembled, changes)
          : await ceoRevise(objective, scope, assembled, changes);
        qa = await qaReview(objective, scope, codeMode ? filesToReviewText(assembled.files) : assembled.deliverable);
        await ev({
          kind: "message",
          from: "qa",
          to: "ceo",
          message: `Re-QA after revision: ${qa.score}/10 — ${qa.passed ? "pass" : "still flagged"}`,
          data: { issues: qa.issues },
        });
      } catch (revErr) {
        assembled = preRevision;
        const why = String(revErr?.message || revErr);
        console.warn(`[mission ${id}] revision skipped, shipping pre-revision draft: ${why}`);
        await ev({
          kind: "error",
          from: codeMode ? "engineer" : "writer",
          to: "ceo",
          message: `Revision pass couldn't finish (${why}) — shipping the working pre-revision draft.`,
        });
      }
    }

    // 8) Deliver.
    await checkpoint(); // honor a stop requested right at the finish line
    await updateMission(id, {
      status: "completed",
      stage: "Delivered",
      quality_score: qa.score,
      completed_at: new Date().toISOString(),
      error: null,
      result: {
        title: assembled.title,
        deliverable: assembled.deliverable,
        files: assembled.files || null, // present for code builds — drives the Code workspace
        debrief: assembled.debrief,
        qa: { score: qa.score, passed: qa.passed, feedback: qa.feedback },
        review: { approved: review.approved, verdict: review.verdict },
      },
    });
    await ev({
      kind: "status",
      from: "ceo",
      to: "founder",
      message: `Delivered "${assembled.title}" — QA ${qa.score}/10`,
    });
    return { ok: true };
  } catch (err) {
    // Founder-requested stop: settle as "stopped" at the current stage, no retry.
    if (err?.stopped) {
      console.log(`[mission ${id}] stopped by founder at "${currentStage}"`);
      await updateMission(id, { status: "stopped", stage: currentStage }).catch(() => {});
      await ev({ kind: "status", from: "system", to: "founder", message: `Mission stopped at ${currentStage}.` });
      return { ok: false, stopped: true };
    }

    const message = String(err?.message || err);
    console.error(`[mission ${id}] failed at "${currentStage}" (attempt ${attempt}/${MAX_MISSION_ATTEMPTS}): ${message}`);
    await ev({ kind: "error", from: "system", to: "founder", message: `${currentStage} failed: ${message}` });

    // Auto-retry once — unless the founder stopped it meanwhile. The retry runs
    // in "resume" mode so completed specialist work isn't redone.
    const stoppedMeanwhile = await getMission(id).then((c) => c && (c.status === "stopping" || c.status === "stopped")).catch(() => false);
    if (attempt < MAX_MISSION_ATTEMPTS && !stoppedMeanwhile) {
      await updateMission(id, { status: "retrying", stage: currentStage, error: `[${currentStage}] ${message}` }).catch(() => {});
      await ev({ kind: "status", from: "system", to: "founder", message: `Auto-retrying (attempt ${attempt + 1}/${MAX_MISSION_ATTEMPTS})…` });
      await new Promise((r) => setTimeout(r, 2500));
      const fresh = (await getMission(id).catch(() => null)) || mission;
      return runAttempt(fresh, { attempt: attempt + 1, resume: true });
    }

    // Retries exhausted (or stopped) — record the real failing stage so the
    // tracker shows exactly which step broke. The founder can hit Retry.
    if (!stoppedMeanwhile) {
      await updateMission(id, { status: "failed", stage: currentStage, error: `[${currentStage}] ${message}` }).catch(() => {});
      await ev({ kind: "error", from: "system", to: "founder", message: `Mission failed at ${currentStage}.` });
    }
    return { ok: false, error: message };
  }
}

// ---------- Pipeline stages ----------

async function ceoScope(objective, grounding = "") {
  return llmJSON({
    system: ROLES.ceo.persona,
    prompt:
      grounding +
      `The founder's objective:\n"${objective}"\n\n` +
      `Scope it. Restate what they want, pick the single most appropriate deliverable_type, ` +
      `and list 3-5 concrete success criteria that define "done".`,
    schema: SCOPE_SCHEMA,
    maxTokens: 1200,
  });
}

async function planner(objective, scope, grounding = "") {
  const plan = await llmJSON({
    system: ROLES.planner.persona,
    prompt:
      grounding +
      `Objective: "${objective}"\n` +
      `CEO scope: ${scope.understanding}\n` +
      `Deliverable type: ${scope.deliverable_type}\n` +
      `Success criteria:\n- ${scope.success_criteria.join("\n- ")}\n\n` +
      `Available specialist roles (assign role= one of these ids only):\n${specialistCatalogue()}\n\n` +
      `Decompose this into at most ${MAX_TASKS} concrete tasks. Use stable keys (t1, t2, ...). ` +
      `Set depends_on to the keys whose output a task needs (empty array if none). ` +
      `Order matters: foundational work (e.g. research) before work that builds on it (e.g. writing).`,
    schema: PLAN_SCHEMA,
    maxTokens: 2500,
  });

  // Repair/validate the planner's output so a hallucinated role or bad dep can't
  // break execution: clamp count, coerce unknown roles to a real specialist, and
  // drop dependencies that don't point at a real task.
  const tasks = (plan.tasks || []).slice(0, MAX_TASKS).map((t, i) => ({
    task_key: t.task_key || `t${i + 1}`,
    title: t.title || `Task ${i + 1}`,
    description: t.description || t.title || "",
    role: resolveSpecialist(t.role).id,
    depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
  }));
  if (!tasks.length) {
    // Degenerate plan — fall back to a single writer task so the mission still runs.
    tasks.push({ task_key: "t1", title: "Produce the deliverable", description: objective, role: "writer", depends_on: [] });
  }
  const keys = new Set(tasks.map((t) => t.task_key));
  for (const t of tasks) t.depends_on = t.depends_on.filter((k) => keys.has(k) && k !== t.task_key);
  return tasks;
}

/**
 * Execute tasks honoring dependencies. Tasks with satisfied deps run in
 * parallel each wave; a task receives the outputs of its dependencies as
 * context (the concrete A2A artifact handoff). A failed specialist degrades to
 * an empty artifact + a logged error rather than aborting the mission.
 */
async function runTasks({ missionId, owner, objective, scope, grounding = "", tasks, ev, checkpoint, codeMode = false }) {
  const outputs = {}; // task_key -> { title, role, output, files? }
  const byKey = Object.fromEntries(tasks.map((t) => [t.task_key, t]));
  const done = new Set();
  const failed = new Set();

  // Resume support: reuse any task that already completed in a prior attempt so
  // we never redo finished specialist work. For builds, recover the files from
  // the stored markdown so a resumed mission still assembles real code.
  for (const t of tasks) {
    if (t.status === "done" && t.output) {
      outputs[t.task_key] = {
        title: t.title,
        role: t.role,
        output: t.output,
        ...(codeMode && t.role === "engineer" ? { files: parseFilesFromMarkdown(t.output) } : {}),
      };
      done.add(t.task_key);
    }
  }

  // Run one specialist task: pull upstream artifacts as context, call the LLM,
  // persist the result (or degrade to a logged failure).
  const runOne = async (t) => {
    const role = ROLES[t.role];
    await updateTask(t.id, { status: "running" });
    await ev({ kind: "status", from: t.role, to: "planner", message: `${role.name} started "${t.title}"` });

    const context = t.depends_on
      .map((d) => outputs[d] && `### From ${ROLES[outputs[d].role]?.name || outputs[d].role} — ${byKey[d]?.title}\n${outputs[d].output}`)
      .filter(Boolean)
      .join("\n\n");

    // In a build, only the engineer ships files. Research/design/analysis tasks
    // stay prose and become context the engineer builds on — so a "research best
    // practices" task isn't awkwardly forced to emit source files.
    const useFiles = codeMode && t.role === "engineer";

    try {
      let output, files;
      if (useFiles) {
        // Build path: produce real files (not a prose description of code). Each
        // file is its own string, so none of them blows the output-token cap the
        // way one giant escaped blob did. maxTokens at the GLM ceiling.
        const res = await llmJSON({
          tier: "code", // route the build to the code-tier model (Groq by default)
          system: role.persona,
          prompt:
            grounding +
            `Mission objective: "${objective}"\n` +
            `YOU ARE BUILDING REAL, RUNNABLE CODE — not a description of it.\n\n` +
            `YOUR TASK: ${t.title}\n${t.description}\n\n` +
            (context ? `Files/work already produced upstream (build ON these — extend them, don't restate them):\n${context}\n\n` : "") +
            `Return every file you create or modify in the files array, each with its COMPLETE contents. ` +
            `A plain front-end app must run by simply opening index.html (inline or link style.css / script.js). ` +
            `No placeholders, no "// TODO", no ASCII-art mockups, no markdown fences inside file contents. ` +
            `Keep it complete but tight enough to fit in one response.`,
          schema: FILES_SCHEMA,
          maxTokens: 8000,
        });
        files = sanitizeFiles(res.files);
        if (!files.length) throw new Error("no usable files were produced");
        output = filesToMarkdown(files); // text form for downstream context + storage + fallback view
      } else {
        const res = await llmJSON({
          system: role.persona,
          prompt:
            grounding +
            `Mission objective: "${objective}"\n` +
            `Deliverable type: ${scope.deliverable_type}\n\n` +
            `YOUR TASK: ${t.title}\n${t.description}\n\n` +
            (context ? `Upstream work handed to you:\n${context}\n\n` : "") +
            `Produce only your part. Be concrete and complete.` +
            (grounding ? ` Use the ground-truth sources above for any facts about the subject; do not substitute your own memory of similarly-named entities.` : ""),
          schema: WORK_SCHEMA,
          maxTokens: 3500,
        });
        output = res.output;
      }
      outputs[t.task_key] = { title: t.title, role: t.role, output, ...(files ? { files } : {}) };
      done.add(t.task_key);
      await updateTask(t.id, { status: "done", output });
      await ev({ kind: "artifact", from: t.role, to: "ceo", message: `${role.name} delivered "${t.title}"`, data: { task_key: t.task_key } });
    } catch (err) {
      const message = String(err?.message || err);
      failed.add(t.task_key);
      await updateTask(t.id, { status: "failed", error: message });
      await ev({ kind: "error", from: t.role, to: "ceo", message: `${role.name} failed "${t.title}": ${message}` });
    }
  };

  while (done.size + failed.size < tasks.length) {
    if (checkpoint) await checkpoint(); // abort between waves if the founder stopped
    const ready = tasks.filter(
      (t) => !done.has(t.task_key) && !failed.has(t.task_key) && t.depends_on.every((d) => done.has(d) || failed.has(d))
    );
    if (!ready.length) break; // dependency cycle — stop cleanly, QA will see the gap

    // Run the ready set in bounded-concurrency batches so we don't fire the
    // whole wave at the LLM at once and trip free-tier rate limits. Code builds
    // go one-at-a-time: two 8k-token engineer calls in the same minute would
    // alone blow Groq's free 12k TPM window and self-inflict a 429.
    const waveSize = codeMode ? 1 : WAVE_CONCURRENCY;
    for (let i = 0; i < ready.length; i += waveSize) {
      if (checkpoint) await checkpoint();
      await Promise.all(ready.slice(i, i + waveSize).map(runOne));
    }
  }
  return tasks.map((t) => outputs[t.task_key]).filter(Boolean);
}

function artifactsBlock(outputs) {
  return outputs
    .map((o) => `### ${ROLES[o.role]?.name || o.role} — ${o.title}\n${o.output}`)
    .join("\n\n");
}

async function ceoAssemble(objective, scope, outputs) {
  if (!outputs.length) {
    // Every specialist failed — don't fabricate; surface the gap honestly.
    return {
      title: "Mission incomplete",
      deliverable: "_No specialist output was produced — every task failed. Check provider keys/logs and re-run._",
      debrief: "All specialist tasks failed; nothing to assemble.",
    };
  }
  return llmJSON({
    system: ROLES.ceo.persona,
    prompt:
      `Objective: "${objective}"\n` +
      `Deliverable type: ${scope.deliverable_type}\n` +
      `Success criteria:\n- ${scope.success_criteria.join("\n- ")}\n\n` +
      `Your specialists produced:\n\n${artifactsBlock(outputs)}\n\n` +
      `Assemble these into ONE cohesive, publish-ready deliverable that satisfies the objective. ` +
      `Remove redundancy, fix seams, and make it read as a single deliberate piece. ` +
      `Then write a short operator debrief for the founder.`,
    schema: ASSEMBLE_SCHEMA,
    maxTokens: 4096,
  });
}

async function qaReview(objective, scope, deliverable) {
  return llmJSON({
    system: ROLES.qa.persona,
    prompt:
      `Objective: "${objective}"\n` +
      `Success criteria:\n- ${scope.success_criteria.join("\n- ")}\n\n` +
      `Deliverable to grade:\n${deliverable}\n\n` +
      `Score it 1-10, set passed (true only if 8+ and all criteria met), list concrete issues, ` +
      `and give one paragraph of feedback.`,
    schema: QA_SCHEMA,
    maxTokens: 1500,
  });
}

async function seniorReview(objective, scope, deliverable, qa) {
  return llmJSON({
    system: ROLES.reviewer.persona,
    prompt:
      `Objective: "${objective}"\n` +
      `QA scored this ${qa.score}/10 with issues: ${(qa.issues || []).join("; ") || "none"}.\n\n` +
      `Deliverable:\n${deliverable}\n\n` +
      `As senior reviewer, decide approved (true/false), give a one-line verdict, and list the ` +
      `minimal required_changes (empty if approved).`,
    schema: REVIEW_SCHEMA,
    maxTokens: 1500,
  });
}

async function ceoRevise(objective, scope, assembled, changes) {
  return llmJSON({
    system: ROLES.ceo.persona,
    prompt:
      `Objective: "${objective}"\n` +
      `Current deliverable titled "${assembled.title}":\n${assembled.deliverable}\n\n` +
      `Required changes:\n- ${changes.join("\n- ")}\n\n` +
      `Revise the deliverable to address every change while keeping what already works. ` +
      `Return the full revised deliverable and an updated debrief.`,
    schema: ASSEMBLE_SCHEMA,
    maxTokens: 4096,
  });
}

// ---------- Code-build path (files in, files out) ----------

/** Normalize a model-supplied path: strip leading ./ or /, unify slashes. */
function normalizePath(p) {
  return String(p || "").trim().replace(/^[./\\]+/, "").replace(/\\/g, "/");
}

/** Clean a model's files array: drop fences, normalize paths, discard empties. */
function sanitizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => {
      let contents = typeof f?.contents === "string" ? f.contents : "";
      // Models sometimes wrap whole-file contents in a markdown fence — strip it.
      contents = contents.replace(/^\s*```[a-zA-Z0-9]*\n?/, "").replace(/\n?```\s*$/, "");
      return { path: normalizePath(f?.path), contents };
    })
    .filter((f) => f.path && f.contents.trim());
}

/** Render files as fenced markdown — the text form stored, passed downstream, and shown as fallback. */
function filesToMarkdown(files) {
  return (files || [])
    .map((f) => {
      const lang = (f.path.split(".").pop() || "").toLowerCase();
      return `**${f.path}**\n\`\`\`${lang}\n${f.contents}\n\`\`\``;
    })
    .join("\n\n");
}

/** Inverse of filesToMarkdown — recover files from stored task output on resume. */
function parseFilesFromMarkdown(text) {
  const files = [];
  const re = /\*\*(.+?)\*\*\s*\n```[^\n]*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const path = normalizePath(m[1]);
    if (path) files.push({ path, contents: m[2] });
  }
  return files;
}

/** Merge files from every specialist: dedupe by path, prefer the larger non-empty version. */
function mergeFiles(outputs) {
  const map = new Map();
  for (const o of outputs) {
    for (const f of o?.files || []) {
      const path = normalizePath(f.path);
      if (!path || typeof f.contents !== "string" || !f.contents.trim()) continue;
      const prev = map.get(path);
      if (!prev || f.contents.length >= prev.length) map.set(path, f.contents);
    }
  }
  return [...map.entries()].map(([path, contents]) => ({ path, contents }));
}

/** Guarantee a runnable entry point so the live preview always has something to load. */
function ensureEntryPoint(files) {
  if (files.some((f) => /\.html?$/i.test(f.path))) return files;
  const css = files.find((f) => /\.css$/i.test(f.path));
  const js = files.find((f) => /\.js$/i.test(f.path));
  files.unshift({
    path: "index.html",
    contents:
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>App</title>\n` +
      (css ? `<link rel="stylesheet" href="${css.path}">\n` : "") +
      `</head>\n<body>\n` +
      (js ? `<script src="${js.path}"></script>\n` : "") +
      `</body>\n</html>\n`,
  });
  return files;
}

/** Concatenate files for QA/Reviewer (capped so a huge project can't blow the prompt). */
function filesToReviewText(files, cap = 14000) {
  const text = (files || [])
    .map((f) => `===== ${f.path} =====\n${f.contents}`)
    .join("\n\n");
  return text.length > cap ? text.slice(0, cap) + "\n\n…(truncated for review)…" : text;
}

function deriveTitle(scope, objective) {
  const s = (scope?.understanding || objective || "Project").replace(/\s+/g, " ").trim();
  return s.length > 70 ? s.slice(0, 67) + "…" : s;
}

function buildDeliverableText(files, title) {
  const list = files
    .map((f) => `- \`${f.path}\` — ${f.contents.split("\n").length} lines`)
    .join("\n");
  return `**${title}** — ${files.length} file(s) built.\n\n${list}\n\nOpen the **Code** tab to edit, run a live preview, or download the project as a ZIP.`;
}

/** Deterministic assembly for builds — no LLM, so working code is never re-flattened. */
function assembleCode(objective, scope, outputs) {
  const files = ensureEntryPoint(mergeFiles(outputs));
  if (!files.length) {
    return {
      title: "Mission incomplete",
      deliverable: "_No code was produced — every build task failed. Check provider keys/logs and re-run._",
      files: [],
      debrief: "All build tasks failed; nothing to assemble.",
    };
  }
  const title = deriveTitle(scope, objective);
  return {
    title,
    deliverable: buildDeliverableText(files, title),
    files,
    debrief: `Built a runnable ${scope.deliverable_type} with ${files.length} file(s): ${files.map((f) => f.path).join(", ")}. Use the Code workspace to preview it live or download the ZIP.`,
  };
}

/** Revision for builds: the engineer returns corrected files, which we re-merge. */
async function codeRevise(objective, scope, assembled, changes) {
  const res = await llmJSON({
    tier: "code", // same code-tier model as the build, for the fix-up pass
    system: ROLES.engineer.persona,
    prompt:
      `Objective: "${objective}"\n` +
      `Current project files:\n${filesToMarkdown(assembled.files)}\n\n` +
      `Required fixes:\n- ${changes.join("\n- ")}\n\n` +
      `Return the COMPLETE updated contents of every file you change (full file, no placeholders, ` +
      `no markdown fences inside contents). Keep everything that already works.`,
    schema: FILES_SCHEMA,
    maxTokens: 8000,
  });
  const fixed = sanitizeFiles(res.files);
  // The revised file always wins over the original (a fix may legitimately
  // shorten a file), so don't route this through mergeFiles' larger-wins rule.
  const map = new Map(assembled.files.map((f) => [f.path, f.contents]));
  for (const f of fixed) map.set(f.path, f.contents);
  const files = ensureEntryPoint([...map.entries()].map(([path, contents]) => ({ path, contents })));
  return { ...assembled, files, deliverable: buildDeliverableText(files, assembled.title) };
}
