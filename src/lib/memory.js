import { db } from "./supabase.js";

/**
 * Agent memory & learning.
 *
 * Every agent recalls relevant memories before it acts (memoryBlock) and the
 * system learns from your approvals/rejections (learnFromDecision). Memories
 * tagged agent='company' are shared by every agent; the rest are private to
 * one department. AYUS can also write memories directly via a tool.
 */

const SHARED = "company";

/**
 * Fetch the most important memories for an agent (its own + company-wide).
 * Ordered by weight then recency. Best-effort — never throws into an agent run.
 */
export async function recall(agent, { limit = 8 } = {}) {
  try {
    const { data, error } = await db
      .from("agent_memory")
      .select("id,kind,content,weight")
      .in("agent", [agent, SHARED])
      .order("weight", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error(`[memory] recall failed for ${agent}: ${err.message || err}`);
    return [];
  }
}

/**
 * A prompt-ready block of what this agent has learned, or "" if it knows nothing
 * yet. Drop this into an agent's system prompt so its behaviour compounds over time.
 */
export async function memoryBlock(agent) {
  const mems = await recall(agent);
  if (!mems.length) return "";
  // Touch last_used_at so frequently-relevant memories stay fresh (fire & forget)
  db.from("agent_memory")
    .update({ last_used_at: new Date().toISOString() })
    .in("id", mems.map((m) => m.id))
    .then(() => {}, () => {});
  const lines = mems.map((m) => `- (${m.kind}) ${m.content}`).join("\n");
  return (
    `\n\nWHAT YOU'VE LEARNED so far (apply these — they come from the founder's past decisions):\n${lines}`
  );
}

/**
 * Store a memory. De-dupes on identical content for the same agent so repeated
 * rejections of the same thing don't pile up — they bump weight instead.
 */
export async function remember({ agent, kind = "note", content, weight = 1, sourceActionId = null }) {
  if (!content?.trim()) return null;
  const owner = agent || SHARED;
  try {
    const { data: existing } = await db
      .from("agent_memory")
      .select("id,weight")
      .eq("agent", owner)
      .eq("content", content)
      .maybeSingle();

    if (existing) {
      const { data } = await db
        .from("agent_memory")
        .update({ weight: existing.weight + weight, last_used_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select("*")
        .single();
      return data;
    }

    const { data, error } = await db
      .from("agent_memory")
      .insert({ agent: owner, kind, content, weight, source_action_id: sourceActionId })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error(`[memory] remember failed: ${err.message || err}`);
    return null;
  }
}

/**
 * Turn an approve/reject into a durable lesson. Cheap by design — no extra LLM
 * call. Rejections become high-weight "avoid this" lessons; an optional founder
 * reason (if the UI passes one) is folded in for both outcomes.
 */
export async function learnFromDecision(action, decision, reason = "") {
  const r = reason?.trim();
  if (decision === "rejected") {
    await remember({
      agent: action.agent,
      kind: "lesson",
      weight: 3,
      sourceActionId: action.id,
      content:
        `Founder REJECTED a "${action.type}" titled "${action.title}". ` +
        (r ? `Reason: ${r}. ` : "") +
        `Avoid proposing this kind of thing again unless clearly justified.`,
    });
  } else if (decision === "approved" && r) {
    // Only record approvals when the founder bothered to leave a note — that's signal.
    await remember({
      agent: action.agent,
      kind: "preference",
      weight: 2,
      sourceActionId: action.id,
      content: `Founder approved "${action.title}" and noted: ${r}`,
    });
  }
}
