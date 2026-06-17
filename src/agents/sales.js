import { db } from "../lib/supabase.js";
import { llmJSON } from "../lib/llm.js";
import { memoryBlock } from "../lib/memory.js";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 10, description: "Lead quality score" },
    reasoning: { type: "string", description: "2-3 sentences explaining the score" },
    followup_subject: { type: "string" },
    followup_body: { type: "string", description: "Plain-text email body" },
  },
  required: ["score", "reasoning", "followup_subject", "followup_body"],
};

/**
 * Sales agent:
 * 1. Picks up leads with status 'new'
 * 2. Scores + qualifies each one
 * 3. Drafts a follow-up email and queues it for your approval
 */
export async function runSalesAgent() {
  const { data: leads, error } = await db
    .from("leads")
    .select("*")
    .eq("status", "new")
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) throw new Error(`leads query failed: ${error.message}`);

  const learned = await memoryBlock("sales");
  let processed = 0;

  for (const lead of leads || []) {
    // Don't duplicate: skip if a follow-up for this lead is already awaiting approval
    // (covers two orchestrators racing, e.g. cron + the dashboard button)
    const { count: pendingCount } = await db
      .from("pending_actions")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("type", "send_followup")
      .eq("payload->>lead_id", lead.id);
    if (pendingCount > 0) continue;

    const result = await llmJSON({
      system:
        "You are the sales agent for AYUS Labs, an Indian digital products studio that builds " +
        "web apps, PDF tools, landing pages and automation for clients. You qualify inbound leads " +
        "and draft warm, concise, professional follow-up emails signed 'Team AYUS Labs'. " +
        "Spam or irrelevant leads should score 1-2." +
        learned,
      prompt:
        `Qualify this lead and draft a follow-up email.\n\n` +
        `Name: ${lead.name}\nEmail: ${lead.email}\nSource: ${lead.source}\nMessage: ${lead.message}`,
      schema: RESULT_SCHEMA,
    });

    await db
      .from("leads")
      .update({ status: "qualified", score: result.score, ai_notes: result.reasoning })
      .eq("id", lead.id);

    // Low-score leads: record the reasoning but don't waste your time with an approval item.
    if (result.score >= 4) {
      await db.from("pending_actions").insert({
        agent: "sales",
        type: "send_followup",
        title: `Follow up with ${lead.name} (score ${result.score}/10)`,
        summary: result.reasoning,
        payload: {
          lead_id: lead.id,
          to: lead.email,
          subject: result.followup_subject,
          body: result.followup_body,
        },
      });
    }

    processed++;
  }

  return { processed, summary: `${processed} new lead(s) qualified` };
}
