import { db } from "../lib/supabase.js";
import { llmJSON } from "../lib/llm.js";
import { memoryBlock } from "../lib/memory.js";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], description: "P0 = drop everything, P3 = backlog" },
    summary: { type: "string", description: "1-2 sentence triage verdict" },
    recommendation: { type: "string", description: "Concrete recommended approach" },
    next_steps: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 5,
      description: "Ordered, actionable next steps",
    },
  },
  required: ["priority", "summary", "recommendation", "next_steps"],
};

/**
 * CTO agent (Vikram):
 * 1. Picks up project updates with status 'new' (bugs, ideas, status notes)
 * 2. Triages: priority + concrete recommendation + next steps
 * 3. Queues the triage for your approval — approving stores it on the update
 */
export async function runCtoAgent() {
  const { data: updates, error } = await db
    .from("project_updates")
    .select("*")
    .eq("status", "new")
    .limit(10);

  if (error) throw new Error(`project_updates query failed: ${error.message}`);

  const learned = await memoryBlock("cto");
  let processed = 0;

  for (const u of updates || []) {
    // Don't duplicate: skip if a triage for this update is already awaiting approval
    const { count: pendingCount } = await db
      .from("pending_actions")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("type", "tech_review")
      .eq("payload->>update_id", u.id);
    if (pendingCount > 0) continue;

    const result = await llmJSON({
      system:
        "You are the CTO agent for AYUS Labs, a one-founder digital products studio. You triage bugs, " +
        "ideas and status updates pragmatically: the founder's time is the scarcest resource, so be " +
        "decisive about priority and concrete about the fix. " +
        "Only reference details you were actually given — never invent placeholders." +
        learned,
      prompt:
        `Triage this project update.\n\n` +
        `Project: ${u.project}\nUpdate:\n${u.update_text}`,
      schema: RESULT_SCHEMA,
      maxTokens: 1000,
    });

    await db.from("pending_actions").insert({
      agent: "cto",
      type: "tech_review",
      title: `[${result.priority}] ${u.project}: ${result.summary.slice(0, 80)}`,
      summary: result.recommendation,
      payload: { update_id: u.id, review: result },
    });

    processed++;
  }

  return { processed, summary: `${processed} update(s) triaged` };
}
