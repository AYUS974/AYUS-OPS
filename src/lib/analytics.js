import { db } from "./supabase.js";

/**
 * Company analytics — everything the Insights tab renders in one call.
 * Aggregates leads, invoices, actions and agent runs into pipeline counts,
 * revenue, 14-day activity timeseries, per-agent workload and a 0-100 health
 * score. All computed in JS from a few bounded queries (no SQL views needed).
 */

const DAY = 86400000;
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

export async function buildAnalytics() {
  const since = new Date(Date.now() - 30 * DAY).toISOString();

  const [leadsR, invoicesR, actionsR, runsR] = await Promise.all([
    db.from("leads").select("status,score,created_at"),
    db.from("invoices").select("amount,currency,status,due_date,created_at"),
    db.from("pending_actions").select("agent,type,status,created_at").gte("created_at", since),
    db.from("agent_runs").select("agent,status,items_processed,created_at").gte("created_at", since),
  ]);

  for (const r of [leadsR, invoicesR, actionsR, runsR]) {
    if (r.error) throw new Error(r.error.message);
  }
  const leads = leadsR.data || [];
  const invoices = invoicesR.data || [];
  const actions = actionsR.data || [];
  const runs = runsR.data || [];

  // ---- Lead pipeline ----
  const pipeline = countBy(leads, (l) => l.status);
  const wonLeads = pipeline.won || 0;
  const totalLeads = leads.length || 0;
  const convertedLeads = (pipeline.qualified || 0) + (pipeline.contacted || 0) + wonLeads;

  // ---- Revenue ----
  const currency = invoices[0]?.currency || "INR";
  const sum = (rows) => rows.reduce((a, b) => a + Number(b.amount || 0), 0);
  const paid = invoices.filter((i) => i.status === "paid");
  const unpaid = invoices.filter((i) => i.status === "unpaid");
  const today = dayKey(Date.now());
  const overdue = unpaid.filter((i) => i.due_date && dayKey(i.due_date) < today);
  const revenue = {
    currency,
    collected: sum(paid),
    outstanding: sum(unpaid),
    overdue: sum(overdue),
    overdueCount: overdue.length,
  };

  // ---- Actions / approval discipline ----
  const actionsByStatus = countBy(actions, (a) => a.status);
  const decided = (actionsByStatus.executed || 0) + (actionsByStatus.approved || 0) + (actionsByStatus.rejected || 0);
  const approved = (actionsByStatus.executed || 0) + (actionsByStatus.approved || 0);
  const approvalRate = decided ? Math.round((approved / decided) * 100) : null;

  // ---- Per-agent workload (last 30d, items processed + actions raised) ----
  const agents = ["sales", "finance", "marketing", "secretary", "hr", "cto"];
  const byAgent = agents.map((a) => ({
    agent: a,
    runs: runs.filter((r) => r.agent === a).length,
    errors: runs.filter((r) => r.agent === a && r.status === "error").length,
    processed: runs.filter((r) => r.agent === a).reduce((s, r) => s + (r.items_processed || 0), 0),
    actions: actions.filter((x) => x.agent === a).length,
  }));

  // ---- 14-day activity timeseries ----
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(Date.now() - i * DAY));
  const series = days.map((d) => ({
    day: d,
    leads: leads.filter((l) => dayKey(l.created_at) === d).length,
    actions: actions.filter((a) => dayKey(a.created_at) === d).length,
    executed: actions.filter((a) => a.status === "executed" && dayKey(a.created_at) === d).length,
  }));

  // ---- Health score (0-100) ----
  const runErrors = runs.filter((r) => r.status === "error").length;
  const reliability = runs.length ? 1 - runErrors / runs.length : 1;
  const collectionHealth = revenue.outstanding ? 1 - revenue.overdue / (revenue.outstanding || 1) : 1;
  const pipelineHealth = totalLeads ? convertedLeads / totalLeads : 0.5;
  const approvalHealth = approvalRate == null ? 0.7 : approvalRate / 100;
  const health = Math.round(
    100 * (0.3 * reliability + 0.3 * collectionHealth + 0.2 * pipelineHealth + 0.2 * approvalHealth)
  );

  return {
    generatedAt: new Date().toISOString(),
    health,
    healthFactors: {
      reliability: Math.round(reliability * 100),
      collection: Math.round(collectionHealth * 100),
      pipeline: Math.round(pipelineHealth * 100),
      approval: Math.round(approvalHealth * 100),
    },
    pipeline,
    leadsTotal: totalLeads,
    revenue,
    actions: { byStatus: actionsByStatus, approvalRate, pending: actionsByStatus.pending || 0 },
    byAgent,
    series,
  };
}

function countBy(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r) || "unknown";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
