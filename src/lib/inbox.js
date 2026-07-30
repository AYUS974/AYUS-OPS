import { db } from "./supabase.js";
import { llmJSON } from "./llm.js";
import { listRecentEmails } from "./google.js";

/**
 * Inbox → Lead Pipeline.
 *
 * Three jobs, one place so the dashboard route and the AYUS chat tool share
 * exactly the same brain:
 *   - listInbox()             → recent inbox mail, annotated (already-a-lead? automated?)
 *   - scanInboxForLeads()     → one batched AI call over the whole inbox, one bulk
 *                               insert at the end. Used by the AYUS chat tool, which
 *                               needs a single final answer, not a progress stream.
 *   - scanInboxForLeadsStream() → same qualification, but one sender at a time,
 *                               most-recent-first, inserting each qualifying lead the
 *                               moment its own verdict is in (via an onEvent callback)
 *                               instead of waiting for the whole inbox to be read.
 *                               Used by the dashboard "Scan inbox → leads" button so
 *                               leads appear live instead of all-at-once at the end.
 * Both skip newsletters, OTPs, receipts, social notifications, recruiters, personal
 * mail and spam, so the pipeline stays clean.
 */

// '"Rahul Sharma" <rahul@x.com>' → { name: "Rahul Sharma", email: "rahul@x.com" }.
// Falls back to a Title-Cased local part when the header carries no display name.
export function parseFromHeader(from = "") {
  const s = String(from).trim();
  const angle = s.match(/<([^>]+)>/);
  const email = ((angle ? angle[1] : (s.match(/[^\s<>"]+@[^\s<>"]+/) || [])[0]) || "").trim().toLowerCase();
  let name = (angle ? s.slice(0, angle.index) : "").trim().replace(/^"(.*)"$/, "$1").trim();
  if (!name && email) {
    name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }
  return { name, email };
}

// Local-parts that are obviously machines, not prospects — never worth a pipeline
// row, and not even worth spending an LLM call on.
export const NON_LEAD_SENDER =
  /^(no[-_.]?reply|donotreply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce|notif(y|ication)?s?)/i;

// Look up which of these emails already exist in the pipeline (case-insensitive).
async function existingLeadEmails() {
  const { data, error } = await db.from("leads").select("email").not("email", "is", null);
  if (error) throw new Error(`could not read existing leads: ${error.message}`);
  return new Set((data || []).map((r) => String(r.email).toLowerCase()));
}

/**
 * Recent inbox mail for the dashboard Inbox view. Every row is tagged with
 * whether that sender is already a lead and whether it looks automated, so the
 * UI can badge them without another round-trip.
 */
export async function listInbox({ maxResults = 20, q = "in:inbox" } = {}) {
  const cap = Math.min(Math.max(Number(maxResults) || 20, 1), 30);
  const emails = await listRecentEmails({ q, maxResults: cap });
  const leadSet = await existingLeadEmails();

  return emails.map((e) => {
    const { name, email } = parseFromHeader(e.from);
    return {
      id: e.id,
      from: e.from,
      name,
      email,
      subject: e.subject,
      snippet: e.snippet,
      date: e.date,
      unread: e.unread,
      alreadyLead: email ? leadSet.has(email) : false,
      automated: email ? NON_LEAD_SENDER.test(email.split("@")[0]) : false,
    };
  });
}

const QUALIFY_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      description: "One verdict per candidate email, echoing its email back.",
      items: {
        type: "object",
        properties: {
          email: { type: "string", description: "The sender email, echoed back exactly as given." },
          is_lead: {
            type: "boolean",
            description: "true only if this sender is a genuine potential business lead (real commercial/prospect intent).",
          },
          score: { type: "integer", minimum: 1, maximum: 10, description: "Lead quality, 10 = hot prospect ready to buy." },
          category: {
            type: "string",
            description: "One of: prospect, client, partner, vendor, recruiter, newsletter, notification, receipt, personal, spam, other.",
          },
          reason: { type: "string", description: "One short sentence justifying the verdict." },
        },
        required: ["email", "is_lead", "score", "category", "reason"],
      },
    },
  },
  required: ["results"],
};

/**
 * Read the founder's inbox, have the AI decide who is a real lead, and insert
 * only those. De-dupes senders within the batch and against existing leads by
 * email, and skips obvious machines before spending an LLM call. Returns a
 * founder-facing breakdown of what was added / skipped / rejected.
 */
export async function scanInboxForLeads({ maxResults = 20, q = "in:inbox" } = {}) {
  const cap = Math.min(Math.max(Number(maxResults) || 20, 1), 25);
  const emails = await listRecentEmails({ q: q || "in:inbox", maxResults: cap });

  // Parse + de-dupe senders within this batch (first/most-recent subject wins).
  const bySender = new Map();
  for (const e of emails) {
    const { name, email } = parseFromHeader(e.from);
    if (!email || NON_LEAD_SENDER.test(email.split("@")[0])) continue;
    if (!bySender.has(email)) bySender.set(email, { name, email, subject: e.subject, snippet: e.snippet });
  }
  const candidates = [...bySender.values()];
  if (!candidates.length) {
    return { ok: true, scanned: emails.length, added: [], skippedExisting: [], notLeads: [], summary: "No human senders found in the recent inbox." };
  }

  // Don't re-analyse or duplicate anyone already in the pipeline.
  const existingSet = await existingLeadEmails();
  const fresh = candidates.filter((c) => !existingSet.has(c.email));
  const skippedExisting = candidates.filter((c) => existingSet.has(c.email)).map((c) => c.email);
  if (!fresh.length) {
    return {
      ok: true,
      scanned: emails.length,
      added: [],
      skippedExisting,
      notLeads: [],
      summary: `All ${skippedExisting.length} recent sender(s) are already in the pipeline.`,
    };
  }

  // AI qualification — one batched call over the fresh senders.
  const analysis = await llmJSON({
    system:
      "You are the inbound lead qualifier for AYUS Labs, an Indian digital-products studio that builds " +
      "web apps, PDF tools, landing pages and automation for clients. You are given a batch of recent " +
      "inbox emails (sender name, email, subject, snippet). For EACH sender, decide whether they are a " +
      "genuine potential business LEAD — a prospective client, partner, or someone with real commercial " +
      "intent to work with or buy from AYUS Labs. Mark is_lead=false for newsletters, marketing blasts, " +
      "OTP/verification codes, social or app notifications, receipts/invoices from services, cold recruiter " +
      "outreach, purely personal mail, and spam. Score 1-10 (10 = hot prospect). Be strict: when in doubt, " +
      "is_lead=false. Echo each sender's email back exactly.",
    prompt:
      "Qualify each of these senders:\n\n" +
      JSON.stringify(
        fresh.map((c) => ({ name: c.name || c.email, email: c.email, subject: c.subject || "", snippet: c.snippet || "" })),
        null,
        2
      ),
    schema: QUALIFY_SCHEMA,
    maxTokens: 1800,
  });

  // Index the verdicts by email so we can align them to candidates.
  const verdicts = new Map();
  for (const r of analysis?.results || []) {
    if (r?.email) verdicts.set(String(r.email).toLowerCase(), r);
  }

  const toInsert = [];
  const notLeads = [];
  for (const c of fresh) {
    const v = verdicts.get(c.email);
    // No verdict → treat conservatively as "not a lead" so we never add noise.
    if (!v || !v.is_lead) {
      notLeads.push({ email: c.email, category: v?.category || "unknown", reason: v?.reason || "not classified as a lead" });
      continue;
    }
    toInsert.push({
      name: c.name || c.email,
      email: c.email,
      source: "inbox",
      status: "new",
      score: Math.min(Math.max(Number(v.score) || 1, 1), 10),
      ai_notes: `${v.category || "prospect"}: ${v.reason || ""}`.slice(0, 500),
      message: c.subject ? `Email: ${c.subject}${c.snippet ? ` — ${c.snippet}` : ""}`.slice(0, 500) : null,
    });
  }

  let added = [];
  if (toInsert.length) {
    const { data, error } = await db.from("leads").insert(toInsert).select("id,name,email,score,ai_notes");
    if (error) return { ok: false, error: `could not add leads: ${error.message}` };
    added = (data || []).map((l) => ({ name: l.name, email: l.email, score: l.score, notes: l.ai_notes }));
  }

  const parts = [`Analysed ${fresh.length} new sender(s): added ${added.length} lead(s)`];
  if (notLeads.length) parts.push(`skipped ${notLeads.length} non-lead`);
  if (skippedExisting.length) parts.push(`${skippedExisting.length} already in pipeline`);

  return {
    ok: true,
    scanned: emails.length,
    added,
    skippedExisting,
    notLeads,
    summary: parts.join(", ") + ".",
  };
}

const QUALIFY_ONE_SCHEMA = {
  type: "object",
  properties: {
    is_lead: {
      type: "boolean",
      description: "true only if this sender is a genuine potential business lead (real commercial/prospect intent).",
    },
    score: { type: "integer", minimum: 1, maximum: 10, description: "Lead quality, 10 = hot prospect ready to buy." },
    category: {
      type: "string",
      description: "One of: prospect, client, partner, vendor, recruiter, newsletter, notification, receipt, personal, spam, other.",
    },
    reason: { type: "string", description: "One short sentence justifying the verdict." },
  },
  required: ["is_lead", "score", "category", "reason"],
};

const QUALIFY_ONE_SYSTEM =
  "You are the inbound lead qualifier for AYUS Labs, an Indian digital-products studio that builds " +
  "web apps, PDF tools, landing pages and automation for clients. You are given one recent inbox email " +
  "(sender name, email, subject, snippet). Decide whether this sender is a genuine potential business " +
  "LEAD — a prospective client, partner, or someone with real commercial intent to work with or buy from " +
  "AYUS Labs. Mark is_lead=false for newsletters, marketing blasts, OTP/verification codes, social or app " +
  "notifications, receipts/invoices from services, cold recruiter outreach, purely personal mail, and spam. " +
  "Score 1-10 (10 = hot prospect). Be strict: when in doubt, is_lead=false.";

/**
 * Same qualification as scanInboxForLeads(), but processed one sender at a time,
 * most-recent-first (the order Gmail already returns them in), with its own LLM
 * call per sender. The moment a sender qualifies, it's inserted into the leads
 * table right away and reported through onEvent — so the founder sees leads land
 * one by one as the scan progresses, instead of waiting for every sender in the
 * batch to be analysed before anything shows up.
 *
 * onEvent(event) is called with:
 *   {type:"start",         scanned, total}
 *   {type:"skip-existing", index, total, email, name}
 *   {type:"not-lead",      index, total, email, name, category, reason}
 *   {type:"lead-added",    index, total, email, name, lead}
 *   {type:"error-item",    index, total, email, name, error}
 *   {type:"done",          ok, scanned, added, skippedExisting, notLeads, summary}
 *
 * Returns the same shape as scanInboxForLeads().
 */
export async function scanInboxForLeadsStream({ maxResults = 20, q = "in:inbox" } = {}, onEvent = () => {}) {
  const cap = Math.min(Math.max(Number(maxResults) || 20, 1), 25);
  const emails = await listRecentEmails({ q: q || "in:inbox", maxResults: cap });

  // Parse + de-dupe senders within this batch, most-recent-first (first occurrence wins).
  const bySender = new Map();
  for (const e of emails) {
    const { name, email } = parseFromHeader(e.from);
    if (!email || NON_LEAD_SENDER.test(email.split("@")[0])) continue;
    if (!bySender.has(email)) bySender.set(email, { name, email, subject: e.subject, snippet: e.snippet });
  }
  const candidates = [...bySender.values()];

  onEvent({ type: "start", scanned: emails.length, total: candidates.length });

  if (!candidates.length) {
    const result = {
      ok: true,
      scanned: emails.length,
      added: [],
      skippedExisting: [],
      notLeads: [],
      summary: "No human senders found in the recent inbox.",
    };
    onEvent({ type: "done", ...result });
    return result;
  }

  const existingSet = await existingLeadEmails();
  const added = [];
  const notLeads = [];
  const skippedExisting = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const progress = { index: i + 1, total: candidates.length, email: c.email, name: c.name };

    if (existingSet.has(c.email)) {
      skippedExisting.push(c.email);
      onEvent({ type: "skip-existing", ...progress });
      continue;
    }

    let verdict;
    try {
      verdict = await llmJSON({
        system: QUALIFY_ONE_SYSTEM,
        prompt:
          "Qualify this sender:\n\n" +
          JSON.stringify({ name: c.name || c.email, email: c.email, subject: c.subject || "", snippet: c.snippet || "" }, null, 2),
        schema: QUALIFY_ONE_SCHEMA,
        maxTokens: 300,
      });
    } catch (err) {
      onEvent({ type: "error-item", ...progress, error: String(err.message || err) });
      notLeads.push({ email: c.email, category: "error", reason: "qualification failed" });
      continue;
    }

    if (!verdict || !verdict.is_lead) {
      const item = { category: verdict?.category || "unknown", reason: verdict?.reason || "not classified as a lead" };
      notLeads.push({ email: c.email, ...item });
      onEvent({ type: "not-lead", ...progress, ...item });
      continue;
    }

    const row = {
      name: c.name || c.email,
      email: c.email,
      source: "inbox",
      status: "new",
      score: Math.min(Math.max(Number(verdict.score) || 1, 1), 10),
      ai_notes: `${verdict.category || "prospect"}: ${verdict.reason || ""}`.slice(0, 500),
      message: c.subject ? `Email: ${c.subject}${c.snippet ? ` — ${c.snippet}` : ""}`.slice(0, 500) : null,
    };

    // Insert the moment this one sender is qualified — don't wait for the rest of
    // the batch, so the pipeline fills in live as each verdict comes back.
    const { data, error } = await db
      .from("leads")
      .insert([row])
      .select("id,name,email,score,ai_notes,status,source,created_at")
      .single();
    if (error) {
      onEvent({ type: "error-item", ...progress, error: error.message });
      notLeads.push({ email: c.email, category: "error", reason: `insert failed: ${error.message}` });
      continue;
    }

    existingSet.add(c.email);
    // Same shape as GET /leads rows, so the frontend can splice this straight
    // into its leads list without any field remapping.
    const lead = {
      id: data.id,
      name: data.name,
      email: data.email,
      score: data.score,
      ai_notes: data.ai_notes,
      status: data.status,
      source: data.source,
      created_at: data.created_at,
    };
    added.push(lead);
    onEvent({ type: "lead-added", ...progress, lead });
  }

  const parts = [`Analysed ${candidates.length - skippedExisting.length} new sender(s): added ${added.length} lead(s)`];
  if (notLeads.length) parts.push(`skipped ${notLeads.length} non-lead`);
  if (skippedExisting.length) parts.push(`${skippedExisting.length} already in pipeline`);

  const result = {
    ok: true,
    scanned: emails.length,
    added,
    skippedExisting,
    notLeads,
    summary: parts.join(", ") + ".",
  };
  onEvent({ type: "done", ...result });
  return result;
}
