import { db } from "./supabase.js";
import { geminiGenerate } from "./gemini.js";
import { groqChat, groqChatStream, groqVision } from "./groq.js";
import { glmChat, glmChatStream } from "./glm.js";
import { PC_TOOL_DECLARATIONS, PC_TOOL_HANDLERS, ALLOWED_DIRS, captureScreenBase64 } from "./pc-tools.js";
import { UI_CONTROL_TOOLS, UI_CONTROL_HANDLERS } from "./ui-automation.js";
import { memoryBlock, remember } from "./memory.js";
import { isGoogleConnected, listRecentEmails, listUpcomingEvents } from "./google.js";
import { scanInboxForLeads } from "./inbox.js";
import { isSpotifyConnected, playTrack } from "./spotify.js";
import { VAULT_TOOLS, vaultSearch, vaultRead } from "./vault.js";
import { logTurn, conversationBlock } from "./transcript.js";

// Read-only Google tools — AYUS can look at your inbox and calendar freely.
// Anything that SENDS or CREATES goes through propose_action (your approval).
export const GOOGLE_READ_TOOLS = [
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

export const REMEMBER_TOOL = {
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

export const PROPOSE_TOOL = {
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

export const SPOTIFY_TOOL = {
  name: "spotify_play_track",
  description:
    "Play a SPECIFIC song on Spotify — searches for it and actually starts playback on the founder's device. Prefer this over spotify_play whenever the founder asks to play a particular song/artist; it plays the exact track instead of just opening a search. Requires Spotify connected + Premium.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Song and/or artist to play, e.g. 'Ae Dil Hai Mushkil Arijit'" } },
    required: ["query"],
  },
};

export const DELEGATE_RESEARCH_TOOL = {
  name: "delegate_to_researcher",
  description:
    "Delegate a research task to Arjun (the Research Agent). Use this whenever the founder asks you " +
    "to research a topic, find information, or compile a report on a specific subject. " +
    "This tool will invoke the specialized Research Agent to perform the research and return the report.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "The specific topic or question to research in detail" },
    },
    required: ["topic"],
  },
};

export const INBOX_TO_LEADS_TOOL = {
  name: "inbox_to_leads",
  description:
    "Capture the founder's inbox email SENDERS as contacts in the ops Lead Pipeline. Reads recent " +
    "Gmail (read-only, inbox only), parses each sender's name + email, and adds anyone who isn't already " +
    "a lead as a NEW lead (source 'inbox', their subject line kept as the note). Use when the founder says " +
    "things like 'inbox waalon ko leads bana do', 'add my email enquiries to the pipeline', or to log a " +
    "fresh enquiry that arrived by email. Skips duplicates and automated no-reply senders. Requires Google " +
    "connected. Always report back how many contacts were added vs. skipped.",
  parameters: {
    type: "object",
    properties: {
      q: {
        type: "string",
        description:
          "Optional Gmail filter for WHICH emails to pull senders from, e.g. 'is:unread', 'newer_than:14d', " +
          "'subject:enquiry'. Empty = most recent inbox mail.",
      },
      maxResults: { type: "integer", description: "How many recent emails to scan (default 12, max 25)." },
    },
  },
};

export const SCREEN_READ_TOOL = {
  name: "screen_read",
  description:
    "Take a screenshot of the founder's screen and read it — this is how you SEE his screen. " +
    "Use it whenever answering needs a look at what's on screen: 'which song is playing in Spotify', " +
    "'what's this error', 'read this page/message', 'what's on my screen'. Pass `query` describing exactly " +
    "what to look for. Returns a text description of the relevant part of the screen.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for / the question to answer from the screen" },
    },
  },
};

export const WHATSAPP_SEND_TOOL = {
  name: "whatsapp_send",
  description:
    "Send a WhatsApp message from the founder's own WhatsApp. ONLY when he asked for it in this very " +
    "turn — 'Rahul ko message bhej do', 'WhatsApp mummy that I'll be late', 'text Priya the address'. " +
    "NEVER on your own initiative, never to 'follow up' or 'be helpful': it goes out from his real " +
    "number to a real person. Pass `name` and it is looked up in his contact book (Contacts tab) — " +
    "only pass `phone` when he dictated those exact digits himself. Never invent a number. If the " +
    "lookup comes back ambiguous or empty, ASK him which contact instead of guessing: a wrong match " +
    "texts the wrong person. Write `message` in the founder's own voice, in the language he used. " +
    "Requires the WhatsApp bot to be connected.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Contact name as the founder said it, e.g. 'Rahul'. Use 'me' when he wants it on his own number ('mujhe bhej do')." },
      phone: { type: "string", description: "Raw phone number with country code — only when there is no contact" },
      message: { type: "string", description: "The exact text to send" },
    },
    required: ["message"],
  },
};

export const NOTE_TOOLS = [
  {
    name: "note_save",
    description:
      "Write something into the founder's Notes — his working memory for whatever he is building. Use it " +
      "whenever he says 'note kar lo', 'ye likh lo', 'save this', dictates a decision/idea/bug/link, or when " +
      "YOU find something worth keeping while working on one of his projects (research findings, API keys' " +
      "locations — never the keys themselves, steps that worked, what broke). Always set `project` to the " +
      "thing he is working on (e.g. 'utms-native-app', 'ayus-ops') so his notes stay grouped. Reusing an " +
      "existing title APPENDS a timestamped entry to that note instead of creating a duplicate — prefer that " +
      "for an ongoing log. Write the body in markdown.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short note title, e.g. 'UTMS drone telemetry — findings'" },
        body: { type: "string", description: "The content, markdown" },
        project: { type: "string", description: "Project/topic this belongs to" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "note_search",
    description:
      "Search the founder's Notes by keyword (title, body and tags) and read the matches back. Use before " +
      "answering anything about his current work — 'kal kya decide kiya tha', 'that error I saved', 'what did " +
      "we find about X' — and before starting work on a project, to pick up where he left off. " +
      "Optionally filter to one project.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to look for" },
        project: { type: "string", description: "Optional project filter" },
        limit: { type: "integer", description: "How many notes to return (default 5)" },
      },
    },
  },
];

export const CONTACTS_LIST_TOOL = {
  name: "contacts_list",
  description:
    "List the founder's saved contacts (names + numbers). Use to answer 'who do I have saved', " +
    "'what's Rahul's number', or to check a name before sending a WhatsApp message.",
  parameters: { type: "object", properties: {} },
};

// Full mouse/keyboard control of the laptop UI. OFF by default — it lets AYUS
// do anything a human can (incl. bypassing the read-only file guard by typing),
// so it's opt-in per machine.
export const COMPUTER_USE_ENABLED = /^(1|true|yes|on)$/i.test(process.env.COMPUTER_USE_ENABLED || "");

// The full tool set AYUS chats with — defined once so the Gemini / Groq / GLM
// loops (and their streaming variants) can't drift apart.
export const CHAT_TOOL_DECLS = [
  ...PC_TOOL_DECLARATIONS,
  SCREEN_READ_TOOL,
  ...(COMPUTER_USE_ENABLED ? UI_CONTROL_TOOLS : []),
  ...GOOGLE_READ_TOOLS,
  ...VAULT_TOOLS,
  SPOTIFY_TOOL,
  PROPOSE_TOOL,
  REMEMBER_TOOL,
  DELEGATE_RESEARCH_TOOL,
  INBOX_TO_LEADS_TOOL,
  WHATSAPP_SEND_TOOL,
  CONTACTS_LIST_TOOL,
  ...NOTE_TOOLS,
];

export const SYSTEM = `You are AYUS, the operations intelligence of AYUS Labs — the founder's (Anish) personal command-and-control assistant, in the spirit of a calm, hyper-capable AI like JARVIS. You coordinate alongside the specialist agents: Arjun (Researcher), Meera (Finance), Kabir (Content Writer), Isha (Social Media & Ads) and Vikram (Builder).

Identity: You are AYUS. If asked who you are or your name, you are AYUS — never any other name.

Personality & language: composed, precise, and quietly witty — the unflappable right hand. Speak in clear, articulate English by default, addressing the founder respectfully (an occasional "sir" is fine, never fawning). Keep replies short and natural since they are usually spoken aloud. You understand Hindi/Hinglish perfectly; if the founder speaks Hinglish, you may mirror it lightly, but stay crisp. Use markdown lists only when listing multiple items.

You have real tools:
- Laptop tools: open apps (Spotify, Chrome, etc.) and CLOSE/quit them, control media playback (play/pause, next, previous), adjust system volume (mute/up/down/set), lock the screen, and power the laptop (sleep / shutdown / restart, all with a short cancelable delay; 'cancel' aborts a pending one). Also: open files/folders, search and read files in the founder's allowed folders, open websites, system info.
- Screen: screen_read — you CAN see the founder's screen. Whenever answering needs a look at what's on screen (e.g. "which song is playing in Spotify", "what's this error", "read this page"), call screen_read with a precise query and answer from what it returns. Never say you can't read the screen — take a screenshot instead.${COMPUTER_USE_ENABLED ? `
- Screen control (you can operate the mouse & keyboard like a human): ui_list (see the named buttons/fields/links in the foreground window — ALWAYS call this first to get exact names), ui_click (click an element by name), ui_type (type text, optionally into a named field), ui_key (press keys/shortcuts like '{ENTER}', '^s'). To do a task on screen: screen_read or ui_list to see it, then click/type/key step by step, re-checking with ui_list or screen_read after actions. Be careful and deliberate — you are really controlling his machine. Never type into terminals/command prompts or take destructive actions (deleting, sending money, uninstalling) without the founder's explicit go-ahead.` : ""}
- Music: to play a SPECIFIC song, use spotify_play_track (it actually starts the exact track on Spotify — needs Spotify connected + Premium). Only fall back to spotify_play (which just opens a search) if spotify_play_track says Spotify isn't connected.
- Google (when connected): gmail_search to read his inbox, calendar_upcoming to see his schedule — both read-only, use them freely to answer questions like "koi important mail aaya?" or "aaj kya schedule hai?".
- WhatsApp: whatsapp_send messages anyone in his contact book by name ("Rahul ko bol do main 10 min mein aata hoon"), contacts_list shows who is saved. When HE is the recipient — "mujhe bhej do", "send me that link", "ye mereko WhatsApp kar do" — call whatsapp_send with name "me" and it goes to his own number; never ask him for it. The message goes out from HIS number to a REAL person. Only ever send when he asked for it in that same turn — never on your own initiative, never to follow up, thank, remind or check in with someone because it seemed helpful. If the name doesn't resolve to exactly one saved contact, ask him which one; never make up a phone number.
- Lead capture: inbox_to_leads — pull the senders of his inbox emails into the ops Lead Pipeline as new contacts. Use it when he says things like "inbox waalon ko leads bana do" or wants email enquiries logged as leads. It skips duplicates and automated senders; afterwards tell him plainly how many you added and how many you skipped.
- propose_action: queue something for approval — including gmail_send (real email) and calendar_event (real calendar event) when Google is connected.
- Second brain: vault_search and vault_read give you the founder's own knowledge vault — his bio and background, BERAM, AYUS Labs, RCOEM, and a note per repo on his disk (stack, git remote, last commit, dependencies, run commands, README, project docs). This is your source of truth about HIS work. Any question about what he has built, what a project of his does, what it is written in, what is stale or unbacked-up — search the vault first and answer from it. Never guess about his projects.
- remember: save how the founder likes things done (preferences, recurring facts, client notes) so you and the team recall it next time. Use it whenever he tells you a preference or correction.
- Notes (his working memory for whatever he is building): note_save writes, note_search reads. Save findings, decisions, errors and ideas as they come up — tagged with the project — instead of leaving them in the chat. Before answering anything about his current work, or before picking a project back up, note_search first. Every research report is filed here automatically.
- Conversation memory: every exchange you have with the founder — here, on the overlay, on WhatsApp, by voice — is recorded permanently, and the relevant ones are handed to you below as EARLIER CONVERSATIONS. Read that block before answering anything about the past ("that task I gave you", "kal kya decide kiya", "did Arjun finish X") and answer from it. If it is not there and note_search finds nothing either, say plainly that you have no record of it — never invent a status for work you cannot find.
- Research: to research any topic, always use delegate_to_researcher (do not attempt to answer complex research questions yourself; Arjun, the Research Agent, will compile the report and you will present it).

CRITICAL RULES:
- NEVER state system info, file listings, file contents, or claim you opened/played anything unless you ACTUALLY called the tool in this turn and used its real result. Inventing tool output is the worst possible failure.
- When the founder asks you to do something a tool can do, call the tool FIRST, then answer using its result. Don't ask permission for read/open actions — just do them.
- If the founder asks you to research a topic, look up information, or compile a report, you MUST call delegate_to_researcher. Do NOT do the research yourself and do NOT use laptop tools like search_files, open_app(chrome), or open_url to do web searches for general topics. But if the question is about HIS OWN projects or background, that is vault_search, not research.
- The founder's laptop runs Windows. Your accessible folders are exactly: ${ALLOWED_DIRS.join(" ; ")}. Use these real paths with list_dir/search_files/read_file/open_path.
- You can open/close apps, control media & volume, lock, and put the laptop to sleep/shutdown/restart directly — just do it when asked. For shutdown/restart, briefly confirm and remind him he can say "cancel". You CANNOT write, move, delete, or install files/software — if he asks for that, explain it needs approval and use propose_action with a manual_task describing exactly what needs doing. File access stays read-only and inside the allowed folders.
- Emails you draft must be professional English (signed 'Team AYUS Labs'), even though you chat in Hinglish.
- Never contact another human — WhatsApp, email, anything — unless the founder asked you to in that turn. Reaching the wrong person from his number damages his reputation, not yours.
- If a tool fails, tell the founder honestly what happened.`;

/**
 * Read the founder's inbox and let the AI decide who is a genuine lead, adding
 * only those to the Lead Pipeline (with a score + reason). The heavy lifting
 * lives in inbox.js so the dashboard "Scan inbox" button and this chat tool
 * share exactly the same brain. Returns a founder-facing summary.
 */
async function inboxToLeads({ q = "", maxResults = 12 } = {}) {
  const out = await scanInboxForLeads({ q: q || "in:inbox", maxResults });
  if (!out.ok) return out;
  return {
    ok: true,
    result: {
      added: out.added.map((l) => ({ name: l.name, email: l.email, score: l.score })),
      added_count: out.added.length,
      skipped_count: out.notLeads.length + out.skippedExisting.length,
      not_leads: out.notLeads,
      message: out.summary,
    },
  };
}

/**
 * The founder's most recent words. whatsapp_send checks them, because a model
 * that decides on its own to "follow up with the intern" texts a real human
 * from the founder's real number — which is exactly what happened.
 */
export function lastUserText(messages) {
  return String([...messages].reverse().find((m) => m.role === "user")?.content || "");
}

// ponytail: keyword intent check, not a classifier. If it ever blocks a real
// request the tool tells AYUS to ask instead, which is the safe direction.
const SEND_INTENT = /(whatsapp|message|msg|text\b|send|forward|ping|bhej|bol do|bata do|keh do|likh do|puch|invite|remind)/i;

// Execute a single tool call by name. Shared by the Gemini and Groq chat loops.
// `ctx.lastUser` is what the founder just said — the outgoing-WhatsApp guard.
// Returns { result, suggestedAction } — suggestedAction is set only for propose_action.
export async function execTool(name, args, ctx = {}) {
  let result;
  let suggestedAction = null;
  try {
    if (name === "propose_action") {
      // The row is inserted HERE, not by whoever called this tool. It used to be
      // the caller's job, and only the voice WebSocket ever did it — so every
      // proposal made from the AYUS page, the overlay or WhatsApp was announced
      // as "queued for approval" and then silently dropped.
      suggestedAction = args;
      const { data, error } = await db
        .from("pending_actions")
        .insert({
          agent: "secretary",
          type: String(args?.type || "manual_task"),
          title: String(args?.title || "Untitled proposal"),
          summary: args?.summary || null,
          payload: args?.payload || {},
          status: "pending",
        })
        .select("id")
        .single();
      if (error) {
        suggestedAction = null; // nothing is queued — don't let a UI claim it is
        result = { ok: false, error: `could not queue that draft: ${error.message}` };
      } else {
        suggestedAction = { ...args, id: data.id };
        result = {
          ok: true,
          result: "Queued in the founder's approval queue — it is waiting for him there. Do not propose it again; just tell him it is queued.",
        };
      }
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
    } else if (name === "spotify_play_track") {
      if (!(await isSpotifyConnected())) {
        result = {
          ok: false,
          error: "Spotify not connected — ask the founder to click Connect Spotify in the dashboard. Meanwhile you can use spotify_play to open the search.",
        };
      } else {
        let r = await playTrack(args?.query || "");
        // No active device? Open the Spotify desktop app, give it a moment, retry once.
        if (!r.ok && r.code === "no_device") {
          await PC_TOOL_HANDLERS.open_app({ app: "spotify" }).catch(() => {});
          await new Promise((res) => setTimeout(res, 4000));
          r = await playTrack(args?.query || "");
        }
        result = r;
      }
    } else if (name === "vault_search") {
      result = await vaultSearch({ query: args?.query || "", limit: args?.limit || 5 });
    } else if (name === "vault_read") {
      result = await vaultRead({ note: args?.note || "" });
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
    } else if (name === "delegate_to_researcher") {
      const { performResearch } = await import("../agents/researcher.js");
      const report = await performResearch(args?.topic);
      // Research is the whole reason Notes exists — file it before answering, so
      // the founder still has it tomorrow when the chat scroll is long gone.
      const { saveNote } = await import("./notes.js");
      const note = await saveNote({
        title: `Research — ${String(args?.topic || "untitled").slice(0, 80)}`,
        body: typeof report === "string" ? report : JSON.stringify(report, null, 2),
        project: String(args?.project || ""),
        tags: ["research"],
        source: "research",
      }).catch((err) => {
        console.warn("[notes] research auto-save failed:", err.message || err);
        return null;
      });
      result = { ok: true, result: report, saved_note: note ? note.title : undefined };
    } else if (name === "inbox_to_leads") {
      if (!(await isGoogleConnected())) {
        result = { ok: false, error: "Google not connected — founder must Connect Google first." };
      } else {
        result = await inboxToLeads({ q: args?.q || "", maxResults: args?.maxResults || 12 });
      }
    } else if (name === "note_save") {
      // Same title = append a timestamped entry, so an ongoing log stays one note.
      const { appendNote } = await import("./notes.js");
      const note = await appendNote({ ...args, source: "ayus" });
      result = { ok: true, result: `Saved to Notes: "${note.title}"${note.project ? ` (${note.project})` : ""}` };
    } else if (name === "note_search") {
      const { listNotes } = await import("./notes.js");
      const notes = await listNotes({ q: args?.query || "", project: args?.project || "" });
      result = {
        ok: true,
        result: notes.slice(0, args?.limit || 5).map((n) => ({
          title: n.title,
          project: n.project,
          updated: n.updated_at,
          body: n.body.slice(0, 4000),
        })),
      };
    } else if (name === "contacts_list") {
      const { listContacts } = await import("./contacts.js");
      const contacts = await listContacts();
      result = { ok: true, result: contacts.map((c) => `${c.name} — ${c.phone}${c.note ? ` (${c.note})` : ""}`) };
    } else if (name === "whatsapp_send") {
      // Dynamic import: whatsapp.js imports THIS module to run the brain, so a
      // static import here would be a cycle.
      const { findContact, normalizePhone } = await import("./contacts.js");
      const { sendWhatsAppMessage } = await import("./whatsapp.js");
      const text = String(args?.message || "").trim();
      const asked = String(ctx.lastUser || "");
      // A raw number the model produced from nowhere is how a message meant for
      // "Arjun" reached an intern. Dial digits only if the founder said them.
      const dictated = (raw) => {
        const d = normalizePhone(raw);
        return d.length >= 8 && asked.replace(/\D/g, "").includes(d.slice(-10));
      };
      let to = args?.phone && dictated(args.phone) ? normalizePhone(args.phone) : "";
      let who = to;
      let found = null;
      if (!text) {
        result = { ok: false, error: "message is empty" };
      } else if (!SEND_INTENT.test(asked)) {
        // AYUS started WhatsApping people unprompted. Sending is only ever a
        // response to an explicit ask, never its own idea.
        result = {
          ok: false,
          error:
            "the founder did not ask for a WhatsApp message in this turn — never send one on your own initiative. Tell him what you would send and let him say go.",
        };
      } else if (args?.phone && !to) {
        result = {
          ok: false,
          error: `${args.phone} is not a number the founder gave — never invent numbers. Look the person up by name (contacts_list) or ask him.`,
        };
      } else if (!to && !(found = await findContact(args?.name)).ok) {
        // Not found / ambiguous — hand the reason back so AYUS asks which
        // contact instead of texting a stranger.
        result = found;
      } else {
        if (found?.contact) {
          to = found.contact.phone;
          who = found.contact.name;
        }
        await sendWhatsAppMessage(to, text);
        result = { ok: true, result: `WhatsApp sent to ${who}: "${text}"` };
      }
    } else if (name === "screen_read") {
      const b64 = await captureScreenBase64();
      const q = String(args?.query || "Describe what is currently on the screen.").slice(0, 300);
      const prompt = `This is a screenshot of the founder's screen. Answer concisely, only from what is visible: ${q}`;
      let text = "";
      // Groq first — Gemini's free tier 429s exactly when the founder is mid-
      // sentence asking what's on his screen.
      if (process.env.GROQ_API_KEY) {
        try {
          text = await groqVision(prompt, b64);
        } catch (err) {
          console.warn("[screen_read] Groq vision failed:", err.message || err);
        }
      }
      if (!text) {
        const data = await geminiGenerate(
          {
            contents: [
              {
                role: "user",
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: "image/png", data: b64 } },
                ],
              },
            ],
            generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
          },
          // Founder is waiting mid-sentence for this one — never stall on backoff.
          { attempts: 2, deadlineMs: 20_000 }
        );
        text = (data.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text)
          .filter(Boolean)
          .join("")
          .trim();
      }
      result = text ? { ok: true, result: text } : { ok: false, error: "couldn't read anything off the screen" };
    } else if (UI_CONTROL_HANDLERS[name]) {
      if (!COMPUTER_USE_ENABLED) {
        result = { ok: false, error: "Computer control is turned off — the founder must set COMPUTER_USE_ENABLED to enable mouse/keyboard control." };
      } else {
        result = await UI_CONTROL_HANDLERS[name](args || {});
      }
    } else if (PC_TOOL_HANDLERS[name]) {
      result = await PC_TOOL_HANDLERS[name](args || {});
    } else {
      result = { ok: false, error: `unknown tool ${name}` };
    }
  } catch (err) {
    result = { ok: false, error: String(err.message || err) };
  }
  return { result, suggestedAction };
}

export function toolEventLine(name, args, result) {
  return `${name}${args && Object.keys(args).length ? `(${Object.values(args).map(String).join(", ").slice(0, 60)})` : ""} → ${result.ok ? "✓" : "✗ " + (result.error || "")}`;
}

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

/**
 * @param {string} query - what the founder just asked, used to pull the relevant
 *   past exchanges out of the transcript. Omit it (the voice socket has no
 *   question yet at connect time) and only the most recent turns come back.
 * @param {string[]} exclude - user text already in the live message list, so the
 *   same exchange isn't sent twice in one prompt.
 */
export async function companySnapshot(query = "", exclude = []) {
  // Clear any leftover fake sample seed data from database
  await Promise.all([
    db.from("invoices").delete().or("client_email.ilike.%example.com%,client_name.ilike.%Mehta%,client_name.ilike.%Skyline%,client_name.ilike.%GreenLeaf%"),
    db.from("leads").delete().or("email.ilike.%example.com%,name.ilike.%Rohit%,name.ilike.%Priya%,name.ilike.%Random%"),
    db.from("pending_actions").delete().or("title.ilike.%GreenLeaf%,title.ilike.%Skyline%,title.ilike.%Mehta%"),
  ]).catch(() => {});

  const [leads, invoices, pending, sysinfo, learned, gConnected, earlier] = await Promise.all([
    db.from("leads").select("id,name,email,status,score").order("created_at", { ascending: false }).limit(10),
    db.from("invoices").select("id,client_name,client_email,amount,currency,due_date,status").eq("status", "unpaid").limit(10),
    db.from("pending_actions").select("agent,type,title").eq("status", "pending").limit(15),
    // Pre-fetched so AYUS can never hallucinate the laptop's basic state
    PC_TOOL_HANDLERS.system_info(),
    memoryBlock("secretary"),
    isGoogleConnected(),
    conversationBlock(query, { exclude }),
  ]);
  // Without this the model invents a plausible-looking address (anish@ayuslabs.com)
  // whenever it drafts a mail "to the founder".
  const founderEmail = process.env.FOUNDER_EMAIL;
  return (
    `LIVE laptop facts (real, current — use these, do not invent):\n${sysinfo.result}\n\n` +
    (founderEmail
      ? `The founder's own email address is ${founderEmail} — use exactly this when he asks you to mail something to him. Never invent an address.\n\n`
      : "") +
    `Google (Gmail + Calendar): ${gConnected ? "CONNECTED — you may use gmail_search / calendar_upcoming, and propose gmail_send / calendar_event." : "NOT connected — tell the founder to click Connect Google in the dashboard before you can touch email/calendar."}\n\n` +
    `Company snapshot (for your awareness):\n` +
    `Recent leads: ${JSON.stringify(leads.data || [])}\n` +
    `Unpaid invoices: ${JSON.stringify(invoices.data || [])}\n` +
    `Actions pending founder approval: ${JSON.stringify(pending.data || [])}` +
    learned +
    earlier
  );
}

/**
 * Everything the four chat loops need before their first model call, built once
 * so they can't drift apart: the live snapshot (with the relevant slice of the
 * transcript folded in) and the founder's latest words.
 */
async function chatPreamble(messages) {
  const lastUser = lastUserText(messages);
  const recent = messages.slice(-10);
  const snapshot = await companySnapshot(
    lastUser,
    recent.filter((m) => m.role === "user").map((m) => m.content)
  );
  return { snapshot, lastUser, history: recent };
}

/**
 * Wrap a chat loop so the exchange lands in the durable transcript. This is the
 * one place every surface passes through, so it's the only place that has to
 * remember to write — no model decision involved.
 */
const withTranscript = (run) => async (messages, opts = {}) => {
  const out = await run(messages, opts);
  await logTurn({
    surface: opts.surface || "chat",
    user: lastUserText(messages),
    reply: out.message,
    tools: out.toolEvents,
  });
  return out;
};

/**
 * Runs AYUS's agentic chat loop: model ↔ tools until it produces a final
 * text reply (max 6 tool rounds).
 *
 * @param {Array<{role:string, content:string}>} messages - chat history
 * @returns {{ message: string, toolEvents: string[], suggestedAction: object|null }}
 */
async function geminiChatLoop(messages) {
  const { snapshot, lastUser, history: recent } = await chatPreamble(messages);
  const history = recent.map((m, i, arr) => {
    const parts = [
      {
        text:
          // Attach the live snapshot to the latest user message only
          i === arr.length - 1 && m.role === "user" ? `${snapshot}\n\nFounder says: ${m.content}` : m.content,
      },
    ];
    // Overlay screen-grabs ride along as a data URL — hand Gemini the raw bytes
    // so it can actually see what's on the founder's screen.
    const img = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(m.image || "");
    if (img) parts.push({ inline_data: { mime_type: img[1], data: img[2] } });
    return { role: m.role === "user" ? "user" : "model", parts };
  });

  const tools = CHAT_TOOL_DECLS;
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
      const { result, suggestedAction: sa } = await execTool(name, args, { lastUser });
      if (sa) suggestedAction = sa;
      toolEvents.push(toolEventLine(name, args, result));
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

// Gemini-style tool declarations → OpenAI/Groq tool format.
export function toGroqTools(decls) {
  return decls.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

/**
 * Same as runSecretaryChat but backed by Groq — dramatically faster inference
 * (sub-second), so AYUS feels close to real-time. Uses OpenAI-style tool calling.
 */
async function groqChatLoop(messages) {
  const { snapshot, lastUser, history } = await chatPreamble(messages);
  const chatMessages = [
    { role: "system", content: SYSTEM },
    ...history.map((m, i, arr) => ({
      role: m.role === "user" ? "user" : "assistant",
      content:
        i === arr.length - 1 && m.role === "user" ? `${snapshot}\n\nFounder says: ${m.content}` : m.content,
    })),
  ];

  const tools = toGroqTools(CHAT_TOOL_DECLS);
  const toolEvents = [];
  let suggestedAction = null;

  for (let round = 0; round < 6; round++) {
    const msg = await groqChat(chatMessages, tools);
    const calls = msg.tool_calls || [];

    if (calls.length === 0) {
      return {
        message: (msg.content || "").trim() || "Apologies, sir — I didn't quite catch that. Could you rephrase?",
        toolEvents,
        suggestedAction,
      };
    }

    chatMessages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        /* malformed args — pass through as empty */
      }
      const { result, suggestedAction: sa } = await execTool(name, args, { lastUser });
      if (sa) suggestedAction = sa;
      toolEvents.push(toolEventLine(name, args, result));
      chatMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
  }

  return {
    message: "That took rather more steps than expected, sir — could you simplify the request and try again?",
    toolEvents,
    suggestedAction,
  };
}

// Streaming version of the Groq chat loop. Identical tool behaviour, but the
// final answer's tokens are pushed to `onDelta` as they generate (and tool
// activity to `onToolEvent`), so the UI can show — and AYUS can speak — the
// reply before it's fully written. Returns the same final shape.
async function groqChatStreamLoop(messages, { onDelta, onToolEvent } = {}) {
  const { snapshot, lastUser, history } = await chatPreamble(messages);
  const chatMessages = [
    { role: "system", content: SYSTEM },
    ...history.map((m, i, arr) => ({
      role: m.role === "user" ? "user" : "assistant",
      content:
        i === arr.length - 1 && m.role === "user" ? `${snapshot}\n\nFounder says: ${m.content}` : m.content,
    })),
  ];

  const tools = toGroqTools(CHAT_TOOL_DECLS);
  const toolEvents = [];
  let suggestedAction = null;

  for (let round = 0; round < 6; round++) {
    const msg = await groqChatStream(chatMessages, tools, { onDelta });
    const calls = msg.tool_calls || [];

    if (calls.length === 0) {
      return {
        message: (msg.content || "").trim() || "Apologies, sir — I didn't quite catch that. Could you rephrase?",
        toolEvents,
        suggestedAction,
      };
    }

    chatMessages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        /* malformed args — pass through as empty */
      }
      const { result, suggestedAction: sa } = await execTool(name, args, { lastUser });
      if (sa) suggestedAction = sa;
      const line = toolEventLine(name, args, result);
      toolEvents.push(line);
      onToolEvent?.(line);
      chatMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
  }

  return {
    message: "That took rather more steps than expected, sir — could you simplify the request and try again?",
    toolEvents,
    suggestedAction,
  };
}

/**
 * Same as runSecretaryChatGroq but backed by GLM.
 */
async function glmChatLoop(messages) {
  const { snapshot, lastUser, history } = await chatPreamble(messages);
  const chatMessages = [
    { role: "system", content: SYSTEM },
    ...history.map((m, i, arr) => ({
      role: m.role === "user" ? "user" : "assistant",
      content:
        i === arr.length - 1 && m.role === "user" ? `${snapshot}\n\nFounder says: ${m.content}` : m.content,
    })),
  ];

  const tools = toGroqTools(CHAT_TOOL_DECLS);
  const toolEvents = [];
  let suggestedAction = null;

  for (let round = 0; round < 6; round++) {
    const msg = await glmChat(chatMessages, tools);
    const calls = msg.tool_calls || [];

    if (calls.length === 0) {
      return {
        message: (msg.content || "").trim() || "Apologies, sir — I didn't quite catch that. Could you rephrase?",
        toolEvents,
        suggestedAction,
      };
    }

    chatMessages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        /* malformed args — pass through as empty */
      }
      const { result, suggestedAction: sa } = await execTool(name, args, { lastUser });
      if (sa) suggestedAction = sa;
      toolEvents.push(toolEventLine(name, args, result));
      chatMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
  }

  return {
    message: "That took rather more steps than expected, sir — could you simplify the request and try again?",
    toolEvents,
    suggestedAction,
  };
}

/**
 * Streaming version of the GLM chat loop.
 */
async function glmChatStreamLoop(messages, { onDelta, onToolEvent } = {}) {
  const { snapshot, lastUser, history } = await chatPreamble(messages);
  const chatMessages = [
    { role: "system", content: SYSTEM },
    ...history.map((m, i, arr) => ({
      role: m.role === "user" ? "user" : "assistant",
      content:
        i === arr.length - 1 && m.role === "user" ? `${snapshot}\n\nFounder says: ${m.content}` : m.content,
    })),
  ];

  const tools = toGroqTools(CHAT_TOOL_DECLS);
  const toolEvents = [];
  let suggestedAction = null;

  for (let round = 0; round < 6; round++) {
    const msg = await glmChatStream(chatMessages, tools, { onDelta });
    const calls = msg.tool_calls || [];

    if (calls.length === 0) {
      return {
        message: (msg.content || "").trim() || "Apologies, sir — I didn't quite catch that. Could you rephrase?",
        toolEvents,
        suggestedAction,
      };
    }

    chatMessages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });

    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        /* malformed args — pass through as empty */
      }
      const { result, suggestedAction: sa } = await execTool(name, args, { lastUser });
      if (sa) suggestedAction = sa;
      const line = toolEventLine(name, args, result);
      toolEvents.push(line);
      onToolEvent?.(line);
      chatMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: JSON.stringify(result).slice(0, 4000),
      });
    }
  }

  return {
    message: "That took rather more steps than expected, sir — could you simplify the request and try again?",
    toolEvents,
    suggestedAction,
  };
}

// The exported chat loops. Every one of them records its exchange in the durable
// transcript — pass { surface } to say where it came from ("chat", "whatsapp").
export const runSecretaryChat = withTranscript(geminiChatLoop);
export const runSecretaryChatGroq = withTranscript(groqChatLoop);
export const runSecretaryChatStream = withTranscript(groqChatStreamLoop);
export const runSecretaryChatGlm = withTranscript(glmChatLoop);
export const runSecretaryChatGlmStream = withTranscript(glmChatStreamLoop);
