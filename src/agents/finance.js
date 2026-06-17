import { db } from "../lib/supabase.js";
import { llmJSON } from "../lib/llm.js";
import { memoryBlock } from "../lib/memory.js";

const DAYS_AHEAD = 5; // start nudging this many days before due date

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    risk_flag: { type: "string", enum: ["none", "watch", "high"] },
    reasoning: { type: "string", description: "1-2 sentences" },
    reminder_subject: { type: "string" },
    reminder_body: { type: "string", description: "Plain-text email body" },
  },
  required: ["risk_flag", "reasoning", "reminder_subject", "reminder_body"],
};

/**
 * Finance agent:
 * 1. Finds unpaid invoices that are overdue or due within DAYS_AHEAD days
 * 2. Flags payment risk
 * 3. Drafts a reminder email and queues it for your approval
 *    (skips invoices already reminded in the last 3 days, and invoices
 *    that already have a reminder sitting in the approval queue)
 */
export async function runFinanceAgent() {
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + DAYS_AHEAD);

  const { data: invoices, error } = await db
    .from("invoices")
    .select("*")
    .eq("status", "unpaid")
    .lte("due_date", horizon.toISOString().slice(0, 10))
    .order("due_date", { ascending: true })
    .limit(10);

  if (error) throw new Error(`invoices query failed: ${error.message}`);

  const learned = await memoryBlock("finance");
  const today = new Date();
  let processed = 0;

  for (const inv of invoices || []) {
    // Don't nag: skip if a reminder went out in the last 3 days
    if (inv.last_reminder_at) {
      const daysSince = (today - new Date(inv.last_reminder_at)) / 86400000;
      if (daysSince < 3) continue;
    }

    // Don't duplicate: skip if a reminder for this invoice is already awaiting approval
    const { count: pendingCount } = await db
      .from("pending_actions")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("type", "send_reminder")
      .eq("payload->>invoice_id", inv.id);
    if (pendingCount > 0) continue;

    const daysOverdue = Math.floor((today - new Date(inv.due_date)) / 86400000);

    const result = await llmJSON({
      system:
        "You are the finance agent for AYUS Labs, a digital products studio. You draft polite but " +
        "firm payment reminder emails signed 'Team AYUS Labs', and you assess payment risk. " +
        "Tone scales with how overdue the invoice is: friendly before due date, firmer when overdue. " +
        "Only reference details you were actually given — never invent placeholders like [Invoice Number]." +
        learned,
      prompt:
        `Draft a payment reminder and assess risk.\n\n` +
        `Client: ${inv.client_name}\nAmount: ${inv.currency} ${inv.amount}\n` +
        `Due date: ${inv.due_date}\nDays overdue (negative = not yet due): ${daysOverdue}`,
      schema: RESULT_SCHEMA,
    });

    await db
      .from("invoices")
      .update({ risk_flag: result.risk_flag === "none" ? null : result.risk_flag })
      .eq("id", inv.id);

    await db.from("pending_actions").insert({
      agent: "finance",
      type: "send_reminder",
      title: `Remind ${inv.client_name} — ${inv.currency} ${inv.amount} (${daysOverdue > 0 ? daysOverdue + "d overdue" : "due soon"})`,
      summary: result.reasoning,
      payload: {
        invoice_id: inv.id,
        to: inv.client_email,
        subject: result.reminder_subject,
        body: result.reminder_body,
      },
    });

    processed++;
  }

  return { processed, summary: `${processed} invoice(s) flagged for reminders` };
}
