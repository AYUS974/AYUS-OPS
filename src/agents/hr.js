import { db } from "../lib/supabase.js";
import { llmJSON } from "../lib/llm.js";
import { memoryBlock } from "../lib/memory.js";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "Candidate fit score 1-10" },
    summary: { type: "string", description: "2-3 sentence screening summary" },
    strengths: { type: "array", items: { type: "string" }, minItems: 1 },
    concerns: { type: "array", items: { type: "string" } },
    interview_questions: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 5,
      description: "Sharp, role-specific interview questions",
    },
  },
  required: ["score", "summary", "strengths", "concerns", "interview_questions"],
};

/**
 * HR agent (Isha):
 * 1. Picks up candidates with status 'new'
 * 2. Screens the resume against the role
 * 3. Queues a screening report + interview questions for your approval —
 *    approving stores it on the candidate record
 */
export async function runHrAgent() {
  const { data: candidates, error } = await db
    .from("candidates")
    .select("*")
    .eq("status", "new")
    .limit(10);

  if (error) throw new Error(`candidates query failed: ${error.message}`);

  const learned = await memoryBlock("hr");
  let processed = 0;

  for (const c of candidates || []) {
    // Don't duplicate: skip if a review for this candidate is already awaiting approval
    const { count: pendingCount } = await db
      .from("pending_actions")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("type", "candidate_review")
      .eq("payload->>candidate_id", c.id);
    if (pendingCount > 0) continue;

    const result = await llmJSON({
      system:
        "You are the HR agent for AYUS Labs, a small digital products studio. You screen candidates " +
        "honestly and practically for a startup environment — shipping ability and ownership matter more " +
        "than pedigree. Be fair to freshers but clear about gaps. " +
        "Only reference details you were actually given — never invent placeholders." +
        learned,
      prompt:
        `Screen this candidate.\n\n` +
        `Name: ${c.name}\nRole applied: ${c.role_applied}\nResume:\n${c.resume_text || "(none provided)"}`,
      schema: RESULT_SCHEMA,
      maxTokens: 1200,
    });

    await db.from("pending_actions").insert({
      agent: "hr",
      type: "candidate_review",
      title: `Screening: ${c.name} — ${c.role_applied} (${result.score}/10)`,
      summary: result.summary,
      payload: { candidate_id: c.id, review: result },
    });

    processed++;
  }

  return { processed, summary: `${processed} candidate(s) screened` };
}
