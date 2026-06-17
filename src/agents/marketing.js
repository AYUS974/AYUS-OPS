import { db } from "../lib/supabase.js";
import { llmJSON } from "../lib/llm.js";
import { memoryBlock } from "../lib/memory.js";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "1-2 sentence overall assessment" },
    hooks: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 3,
      description: "Three stronger hooks for this draft",
    },
    improvements: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      description: "Specific, concrete changes",
    },
  },
  required: ["verdict", "hooks", "improvements"],
};

/**
 * Marketing agent:
 * 1. Picks up content items with status 'draft'
 * 2. Reviews each draft, suggests 3 stronger hooks + concrete improvements
 * 3. Queues the review for your approval — approving stores it on the content item
 *    (skips drafts that already have a review awaiting approval)
 */
export async function runMarketingAgent() {
  const { data: items, error } = await db
    .from("content_items")
    .select("*")
    .eq("status", "draft")
    .limit(10);

  if (error) throw new Error(`content query failed: ${error.message}`);

  const learned = await memoryBlock("marketing");
  let processed = 0;

  for (const item of items || []) {
    // Don't duplicate: skip if a review for this draft is already awaiting approval
    const { count: pendingCount } = await db
      .from("pending_actions")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("type", "content_review")
      .eq("payload->>content_id", item.id);
    if (pendingCount > 0) continue;

    const result = await llmJSON({
      system:
        "You are the marketing agent for AYUS Labs, a faceless digital products studio posting " +
        "builder-focused content. You review drafts for clarity and engagement, and you write " +
        "scroll-stopping but honest hooks — no fake claims, no engagement bait." +
        learned,
      prompt:
        `Review this draft.\n\nPlatform: ${item.platform}\nTitle: ${item.title}\nDraft:\n${item.draft}`,
      schema: RESULT_SCHEMA,
      maxTokens: 1200,
    });

    await db.from("pending_actions").insert({
      agent: "marketing",
      type: "content_review",
      title: `Review ready: "${item.title}" (${item.platform})`,
      summary: result.verdict,
      payload: { content_id: item.id, review: result },
    });

    processed++;
  }

  return { processed, summary: `${processed} draft(s) reviewed` };
}
