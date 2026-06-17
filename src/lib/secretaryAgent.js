import { db } from "./supabase.js";
import { geminiGenerate } from "./gemini.js";
import { PC_TOOL_DECLARATIONS, PC_TOOL_HANDLERS, ALLOWED_DIRS } from "./pc-tools.js";
import { memoryBlock, remember } from "./memory.js";
import { isGoogleConnected, listRecentEmails, listUpcomingEvents } from "./google.js";

// Read-only Google tools — AYUS can look at your inbox and calendar freely.
// Anything that SENDS or CREATES goes through propose_action (your approval).
const GOOGLE_READ_TOOLS = [
  {
    name: "gmail_search",
    description:
      "Search/read the founder's Gmail (read-only). Use Gmail query syntax, e.g. " +
      "'is:unread', 'from:client newer_than:7d', 'subject:invoice'. Returns sender, subject, snippet.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Gmail search query (empty = most recent)" },
        maxResults: { type: "integer" },
      },
    },
  },
  {
    name: "calendar_upcoming",
    description: "List the founder's upcoming Google Calendar events (read-only).",
    parameters: {
      type: "object",
      properties: { maxResults: { type: "integer" } },
    },
  },
];

const REMEMBER_TOOL = {
  name: "remember",
  description:
    "Save a durable fact or preference so you (and the other agents) recall it in future. " +
    "Use this whenever the founder tells you how he likes things done, a recurring fact, or a " +
    "client/personal note (e.g. 'always remind me about invoices on Mondays', 'I prefer short emails'). " +
    "Set scope='company' to share it with all agents, or 'secretary' to keep it yours.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact/preference, written so it's useful later" },
      kind: { type: "string", enum: ["preference", "fact", "client_note", "note"] },
      scope: { type: "string", enum: ["company", "secretary"] },
    },
    required: ["content"],
  },
};

const PROPOSE_TOOL = {
  name: "propose_action",
  description:
    "Draft a proposal for the founder's approval queue. Nothing is executed until he approves it. Types:\n" +
    "• 'gmail_send' — send a REAL email from his Gmail (payload: to, subject, body, optional cc)\n" +
    "• 'calendar_event' — create a REAL Google Calendar event (payload: summary, start ISO, end ISO, attendees[])\n" +
    "• 'send_followup' / 'send_reminder' — stub/Resend email (payload: to, subject, body, optional lead_id/invoice_id)\n" +
    "• 'manual_task' — to-dos (payload: { tasks: [{ task_title, task_description }] })\n" +
    "Prefer gmail_send / calendar_event when Google is connected.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["gmail_send", "calendar_event", "send_followup", "send_reminder", "manual_task"],
      },
      title: { type: "string" },
      summary: { type: "string" },
      payload: {
        type: "object",
        properties: {
          to: { type: "string" },
          cc: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          summary: { type: "string", description: "Calendar event title" },
          start: { type: "string", description: "Event start, ISO 8601" },
          end: { type: "string", description: "Event end, ISO 8601" },
          attendees: { type: "array", items: { type: "string" } },
          lead_id: { type: "string" },
          invoice_id: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                task_title: { type: "string" },
                task_description: { type: "string" },
              },
            },
          },
        },
      },
    },
    required: ["type", "title", "summary", "payload"],
  },
};

const SYSTEM = `You are AYUS, the operations intelligence of AYUS Labs — the founder's (Anish) personal command-and-control assistant, in the spirit of a calm, hyper-capable AI like JARVIS. You coordinate alongside the specialist agents: Arjun (sales), Meera (finance), Kabir (marketing), Isha (HR) and Vikram (CTO).

Identity: You are AYUS. If asked who you are or your name, you are AYUS — never any other name.

Personality & language: composed, precise, and quietly witty — the unflappable right hand. Speak in clear, articulate English by default, addressing the founder respectfully (an occasional "sir" is fine, never fawning). Keep replies short and natural since they are usually spoken aloud. You understand Hindi/Hinglish perfectly; if the founder speaks Hinglish, you may mirror it lightly, but stay crisp. Use markdown lists only when listing multiple items.

You have real tools:
- Laptop tools: open apps (Spotify, Chrome, etc.), play music via Spotify search, open files/folders, search and read files in the founder's allowed folders, open websites, system info.
- Google (when connected): gmail_search to read his inbox, calendar_upcoming to see his schedule — both read-only, use them freely to answer questions like "koi important mail aaya?" or "aaj kya schedule hai?".
- propose_action: queue something for approval — including gmail_send (real email) and calendar_event (real calendar event) when Google is connected.
- remember: save how the founder likes things done (preferences, recurring facts, client notes) so you and the team recall it next time. Use it whenever he tells you a preference or correction.

CRITICAL RULES:
- NEVER state system info, file listings, file contents, or claim you opened/played anything unless you ACTUALLY called the tool in this turn and used its real result. Inventing tool output is the worst possible failure.
- When the founder asks you to do something a tool can do, call the tool FIRST, then answer using its result. Don't ask permission for read/open actions — just do them.
- The founder's laptop runs Windows. Your accessible folders are exactly: ${ALLOWED_DIRS.join(" ; ")}. Use these real paths with list_dir/search_files/read_file/open_path.
- You can ONLY read and open things on the laptop. If the founder asks you to delete, modify, move or install anything, explain that it needs approval and use propose_action with a manual_task describing exactly what needs doing.
- Emails you draft must be professional English (signed 'Team AYUS Labs'), even though you chat in Hinglish.
- If a tool fails, tell the founder honestly what happened.`;

async function callGemini(contents, tools) {
  const data = await geminiGenerate(
    {
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      generationConfig: { maxOutputTokens: 1200, temperature: 0.4 },
    },
    { attempts: 3 } // chat must stay responsive — fail fast-ish on hard limits
  );
  return data.candidates?.[0]?.content?.parts || [];
}

async function companySnapshot() {
  const [leads, invoices, pending, sysinfo, learned, gConnected] = await Promise.all([
    db.from("leads").select("id,name,email,status,score").order("created_at", { ascending: false }).limit(10),
    db.from("invoices").select("id,client_name,client_email,amount,currency,due_date,status").eq("status", "unpaid").limit(10),
    db.from("pending_actions").select("agent,type,title").eq("status", "pending").limit(15),
    // Pre-fetched so AYUS can never hallucinate the laptop's basic state
    PC_TOOL_HANDLERS.system_info(),
    memoryBlock("secretary"),
    isGoogleConnected(),
  ]);
  return (
    `LIVE laptop facts (real, current — use these, do not invent):\n${sysinfo.result}\n\n` +
    `Google (Gmail + Calendar): ${gConnected ? "CONNECTED — you may use gmail_search / calendar_upcoming, and propose gmail_send / calendar_event." : "NOT connected — tell the founder to click Connect Google in the dashboard before you can touch email/calendar."}\n\n` +
    `Company snapshot (for your awareness):\n` +
    `Recent leads: ${JSON.stringify(leads.data || [])}\n` +
    `Unpaid invoices: ${JSON.stringify(invoices.data || [])}\n` +
    `Actions pending founder approval: ${JSON.stringify(pending.data || [])}` +
    learned
  );
}

/**
 * Runs AYUS's agentic chat loop: model ↔ tools until it produces a final
 * text reply (max 6 tool rounds).
 *
 * @param {Array<{role:string, content:string}>} messages - chat history
 * @returns {{ message: string, toolEvents: string[], suggestedAction: object|null }}
 */
export async function runSecretaryChat(messages) {
  const snapshot = await companySnapshot();
  const history = messages.slice(-10).map((m, i, arr) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [
      {
        text:
          // Attach the live snapshot to the latest user message only
          i === arr.length - 1 && m.role === "user" ? `${snapshot}\n\nFounder says: ${m.content}` : m.content,
      },
    ],
  }));

  const tools = [...PC_TOOL_DECLARATIONS, ...GOOGLE_READ_TOOLS, PROPOSE_TOOL, REMEMBER_TOOL];
  const contents = [...history];
  const toolEvents = [];
  let suggestedAction = null;

  for (let round = 0; round < 6; round++) {
    const parts = await callGemini(contents, tools);
    const calls = parts.filter((p) => p.functionCall);
    const text = parts.filter((p) => p.text).map((p) => p.text).join("").trim();

    if (calls.length === 0) {
      return { message: text || "Apologies, sir — I didn't quite catch that. Could you rephrase?", toolEvents, suggestedAction };
    }

    contents.push({ role: "model", parts });
    const responseParts = [];

    for (const { functionCall } of calls) {
      const { name, args } = functionCall;
      let result;
      try {
        if (name === "propose_action") {
          suggestedAction = args;
          result = { ok: true, result: "Draft ready — it will be shown to the founder to add to the approval queue." };
        } else if (name === "gmail_search") {
          if (!(await isGoogleConnected())) {
            result = { ok: false, error: "Google not connected — founder must Connect Google first." };
          } else {
            const emails = await listRecentEmails({ q: args?.q || "", maxResults: args?.maxResults || 8 });
            result = { ok: true, result: emails };
          }
        } else if (name === "calendar_upcoming") {
          if (!(await isGoogleConnected())) {
            result = { ok: false, error: "Google not connected — founder must Connect Google first." };
          } else {
            const events = await listUpcomingEvents({ maxResults: args?.maxResults || 10 });
            result = { ok: true, result: events };
          }
        } else if (name === "remember") {
          const saved = await remember({
            agent: args?.scope === "secretary" ? "secretary" : "company",
            kind: args?.kind || "preference",
            content: args?.content,
            weight: 2,
          });
          result = saved
            ? { ok: true, result: "Noted, sir — I'll keep that in mind going forward." }
            : { ok: false, error: "could not save memory" };
        } else if (PC_TOOL_HANDLERS[name]) {
          result = await PC_TOOL_HANDLERS[name](args || {});
        } else {
          result = { ok: false, error: `unknown tool ${name}` };
        }
      } catch (err) {
        result = { ok: false, error: String(err.message || err) };
      }
      toolEvents.push(
        `${name}${args && Object.keys(args).length ? `(${Object.values(args).map(String).join(", ").slice(0, 60)})` : ""} → ${result.ok ? "✓" : "✗ " + (result.error || "")}`
      );
      responseParts.push({ functionResponse: { name, response: result } });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return {
    message: "That took rather more steps than expected, sir — could you simplify the request and try again?",
    toolEvents,
    suggestedAction,
  };
}
