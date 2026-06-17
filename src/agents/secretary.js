import { db } from "../lib/supabase.js";
import { llmJSON } from "../lib/llm.js";

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    agenda_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task_title: { type: "string" },
          task_description: { type: "string" }
        },
        required: ["task_title", "task_description"]
      },
      description: "List of 2-4 specific, actionable administrative tasks or recommendations for the founder today."
    },
    briefing: {
      type: "string",
      description: "A short, composed morning greeting and quick operational summary from AYUS (2-3 sentences)."
    }
  },
  required: ["agenda_items", "briefing"]
};

/**
 * Secretary agent:
 * 1. Analyzes the current status of leads, invoices, and content
 * 2. Proposes a custom set of manual tasks/reminders for the CEO to approve and look at
 * 3. Skips if a briefing was already created today
 */
export async function runSecretaryAgent() {
  const [leadsRes, invoicesRes, contentRes] = await Promise.all([
    db.from("leads").select("*").order("created_at", { ascending: false }).limit(10),
    db.from("invoices").select("*").eq("status", "unpaid").order("due_date", { ascending: true }).limit(10),
    db.from("content_items").select("*").limit(10)
  ]);

  if (leadsRes.error || invoicesRes.error || contentRes.error) {
    throw new Error(`Data fetch failed in Secretary agent`);
  }

  const leads = leadsRes.data || [];
  const invoices = invoicesRes.data || [];
  const content = contentRes.data || [];

  // Check if we already created a secretary briefing for today (to avoid duplicates)
  const todayStart = new Date();
  todayStart.setHours(0,0,0,0);
  const { count: pendingBriefCount } = await db
    .from("pending_actions")
    .select("*", { count: "exact", head: true })
    .eq("agent", "secretary")
    .eq("type", "manual_task")
    .gte("created_at", todayStart.toISOString());

  if (pendingBriefCount > 0) {
    return { processed: 0, summary: "Daily secretary task already proposed today" };
  }

  // Use LLM to compile tasks
  const result = await llmJSON({
    system:
      "You are AYUS, the calm, hyper-capable operations intelligence of AYUS Labs (in the spirit of JARVIS). " +
      "Your job is to analyze the current state of leads, invoices, and content, and propose a concise personal agenda " +
      "or specific tasks for the founder to approve and execute today. Be composed, precise, and professional; write in clear English.",
    prompt:
      `Analyze the database state and propose today's personal tasks.\n\n` +
      `Active Leads: ${JSON.stringify(leads.map(l => ({ name: l.name, score: l.score, status: l.status, source: l.source })))}\n\n` +
      `Unpaid Invoices: ${JSON.stringify(invoices.map(i => ({ client: i.client_name, amount: `${i.currency} ${i.amount}`, due: i.due_date, risk: i.risk_flag })))}\n\n` +
      `Content items: ${JSON.stringify(content.map(c => ({ title: c.title, platform: c.platform, status: c.status })))}\n\n` +
      `Generate a morning briefing and an actionable set of 2-4 tasks for the founder.`,
    schema: RESULT_SCHEMA,
    maxTokens: 1200
  });

  // Insert a single pending action of type manual_task which represents this daily agenda
  await db.from("pending_actions").insert({
    agent: "secretary",
    type: "manual_task",
    title: `Secretary Briefing: Founder Agenda`,
    summary: result.briefing,
    payload: {
      tasks: result.agenda_items
    }
  });

  return { processed: 1, summary: "Founder daily agenda proposed" };
}
