import { db } from "./supabase.js";

/**
 * Inter-agent handoffs — what makes AYUS Ops feel like a real company.
 *
 * After you APPROVE one agent's action and it executes, dispatchHandoffs looks
 * at what just happened and queues the natural next step for another department.
 * Approving a candidate screening makes HR queue the interview; approving a P0
 * triage spins up a war-room task; closing attention on a hot lead hands the
 * build over to the CTO to scope. One decision flows through the org.
 *
 * Returns the list of follow-on items created, so the caller can notify you.
 */
export async function dispatchHandoffs(action) {
  try {
    switch (action.type) {
      case "candidate_review":
        return await afterCandidateReview(action);
      case "tech_review":
        return await afterTechReview(action);
      case "send_followup":
        return await afterLeadFollowup(action);
      default:
        return [];
    }
  } catch (err) {
    // Handoffs are a bonus — never fail the original approval because of them.
    console.error(`[handoff] failed for ${action.type}: ${err.message || err}`);
    return [];
  }
}

// HR: a strong candidate (>=7) you approved → queue the interview scheduling.
async function afterCandidateReview(action) {
  const score = action.payload?.review?.score ?? 0;
  const candidateId = action.payload?.candidate_id;
  if (score < 7 || !candidateId) return [];

  const { data: cand } = await db
    .from("candidates")
    .select("id,name,role_applied,email")
    .eq("id", candidateId)
    .maybeSingle();
  if (!cand) return [];

  // Don't double-schedule
  const { count } = await db
    .from("pending_actions")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending")
    .eq("type", "schedule_interview")
    .eq("payload->>candidate_id", candidateId);
  if (count > 0) return [];

  const created = await queue({
    agent: "hr",
    type: "schedule_interview",
    title: `Schedule interview — ${cand.name} (${cand.role_applied})`,
    summary: `Isha rates ${cand.name} ${score}/10. Approve to move them to the interview stage${cand.email ? " and put a 30-min slot on your calendar" : ""}.`,
    payload: {
      candidate_id: cand.id,
      candidate_name: cand.name,
      candidate_email: cand.email,
      role: cand.role_applied,
    },
    parent: action,
  });
  return created ? [created] : [];
}

// CTO: a P0/P1 triage you approved → urgent war-room task so it doesn't slip.
async function afterTechReview(action) {
  const review = action.payload?.review || {};
  if (!["P0", "P1"].includes(review.priority)) return [];

  const project = action.title?.replace(/^\[P[0-3]\]\s*/, "") || "project";
  const created = await queue({
    agent: "cto",
    type: "manual_task",
    urgent: review.priority === "P0",
    title: `${review.priority} war-room: ${project.slice(0, 60)}`,
    summary: review.recommendation || "High-priority issue — confirm the plan and owner.",
    payload: {
      tasks: (review.next_steps || []).map((s, i) => ({
        task_title: `Step ${i + 1}`,
        task_description: s,
      })),
    },
    parent: action,
  });
  return created ? [created] : [];
}

// Sales → CTO: a hot lead (score >=8) you've started a conversation with →
// hand the build over to the CTO to scope, so the proposal is ready fast.
async function afterLeadFollowup(action) {
  const leadId = action.payload?.lead_id;
  if (!leadId) return [];

  const { data: lead } = await db
    .from("leads")
    .select("id,name,score,message")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead || (lead.score ?? 0) < 8) return [];

  // Only hand off once per lead
  const { count } = await db
    .from("project_updates")
    .select("*", { count: "exact", head: true })
    .eq("project", `Lead: ${lead.name}`);
  if (count > 0) return [];

  const { data: row, error } = await db
    .from("project_updates")
    .insert({
      project: `Lead: ${lead.name}`,
      update_text:
        `Hot inbound lead (sales score ${lead.score}/10). Scope a quick build/proposal so we can move fast.\n` +
        `What they asked for: ${lead.message || "(see lead record)"}`,
      status: "new",
    })
    .select("id")
    .single();
  if (error) throw error;

  return [
    {
      agent: "cto",
      type: "scope_request",
      title: `CTO to scope a proposal for hot lead ${lead.name}`,
      id: row.id,
    },
  ];
}

// Insert a follow-on pending_action carrying handoff lineage in meta.
async function queue({ agent, type, title, summary, payload, urgent = false, parent }) {
  const { data, error } = await db
    .from("pending_actions")
    .insert({
      agent,
      type,
      title,
      summary,
      payload: payload || {},
      urgent,
      meta: { via: "handoff", from: parent?.agent, parent_action_id: parent?.id },
    })
    .select("id,agent,type,title,urgent")
    .single();
  if (error) throw error;
  return data;
}
