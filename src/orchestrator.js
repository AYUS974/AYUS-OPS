import "./lib/ca.js";
import "dotenv/config";
import { db } from "./lib/supabase.js";
import { llmJSON } from "./lib/llm.js";
import { notify, esc } from "./lib/notify.js";
import { runSalesAgent } from "./agents/sales.js";
import { runFinanceAgent } from "./agents/finance.js";
import { runMarketingAgent } from "./agents/marketing.js";
import { runSecretaryAgent } from "./agents/secretary.js";
import { runHrAgent } from "./agents/hr.js";
import { runCtoAgent } from "./agents/cto.js";

// To add a new department: write src/agents/yourAgent.js following the
// same pattern (fetch → llmJSON → pending_actions) and register it here.
const AGENTS = [
  ["sales", runSalesAgent],
  ["finance", runFinanceAgent],
  ["marketing", runMarketingAgent],
  ["secretary", runSecretaryAgent],
  ["hr", runHrAgent],
  ["cto", runCtoAgent],
];

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    digest: { type: "string", description: "3-5 sentences, plain text, no fluff" },
  },
  required: ["digest"],
};

async function runOne(name, fn) {
  try {
    const r = await fn();
    await db.from("agent_runs").insert({
      agent: name,
      status: "ok",
      items_processed: r.processed,
      summary: r.summary,
    });
    console.log(`[${name}] ok — ${r.summary}`);
    return { agent: name, status: "ok", ...r };
  } catch (err) {
    const message = String(err.message || err);
    await db
      .from("agent_runs")
      .insert({ agent: name, status: "error", summary: message })
      .then(() => {});
    console.error(`[${name}] error — ${message}`);
    return { agent: name, status: "error", error: message };
  }
}

export async function runAll() {
  console.log(`[orchestrator] run started ${new Date().toISOString()}`);

  // Departments are independent, so they run in parallel. runOne never
  // throws — every outcome lands in agent_runs either way.
  const results = await Promise.all(AGENTS.map(([name, fn]) => runOne(name, fn)));

  // Daily digest — best effort, the run still counts if this fails
  try {
    const { count } = await db
      .from("pending_actions")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");

    const { digest } = await llmJSON({
      system:
        "You are the chief-of-staff agent for AYUS Labs. Write a crisp daily ops digest " +
        "for the founder: what the agents did, what needs his decision, anything at risk. " +
        "Write it in natural Hinglish (casual Hindi-English mix, Roman script) — warm but no fluff.",
      prompt:
        `Agent run results: ${JSON.stringify(results)}\n` +
        `Total actions awaiting approval: ${count ?? "unknown"}`,
      schema: DIGEST_SCHEMA,
      maxTokens: 600,
    });

    await db.from("daily_digests").insert({ content: digest });

    // Push the brief to you (Telegram if configured, else server console).
    const okCount = results.filter((r) => r.status === "ok").length;
    notify(
      `🗞️ <b>AYUS Ops — daily brief</b>\n${esc(digest)}\n\n` +
        `<i>${okCount}/${results.length} agents ran · ${count ?? 0} awaiting your approval</i>`
    ).catch(() => {});
  } catch (err) {
    console.error(`[digest] skipped — ${String(err.message || err)}`);
  }

  console.log(`[orchestrator] run finished`);
  return results;
}
