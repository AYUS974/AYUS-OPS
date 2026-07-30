// Conversation memory — the durable record of what was actually said.
//
// Notes and agent_memory only hold what the model decided was worth an explicit
// note_save / remember call. Everything else — a task delegated in passing, a
// decision made out loud — lived in the browser's localStorage, per surface,
// capped at the last 10 turns the client bothered to send. So the founder asks
// about a task he handed over last week and AYUS has genuinely never heard of it.
//
// Every turn from every surface (dashboard, overlay, WhatsApp, voice) is appended
// here as one JSON line, and the relevant ones are fed back into the next turn's
// system context. Same JSON-file store as notes.js/contacts.js: data/ is
// gitignored, so a private transcript never leaves the machine.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE =
  process.env.TRANSCRIPT_FILE || path.join(__dirname, "..", "..", "data", "transcript.jsonl");

// ponytail: append-only file, linear scan, keyword match. One founder and a few
// thousand turns fits comfortably; move to Postgres full-text (or embeddings, if
// keywords start missing paraphrases) when the scan is measurably slow.
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_TURNS = 4000;

async function readTurns() {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // a half-written line survives as a skipped one, not a crash
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function trimIfHuge() {
  const { size } = await fs.stat(FILE);
  if (size < MAX_BYTES) return;
  const turns = (await readTurns()).slice(-KEEP_TURNS);
  await fs.writeFile(FILE, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
}

/**
 * Record one exchange. Best-effort — a failed write must never break a reply.
 * `tools` is the toolEvents lines, so "did Arjun ever run that research?" can be
 * answered from the transcript even when the answer text was vague.
 */
export async function logTurn({ surface = "chat", user = "", reply = "", tools = [] } = {}) {
  const u = String(user || "").trim();
  const r = String(reply || "").trim();
  if (!u && !r) return;
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      surface,
      user: u.slice(0, 2000),
      reply: r.slice(0, 2000),
      tools: (Array.isArray(tools) ? tools : []).slice(0, 8).map((t) => String(t).slice(0, 160)),
    });
    await fs.appendFile(FILE, line + "\n");
    await trimIfHuge();
  } catch (err) {
    console.warn("[transcript] log failed:", err.message || err);
  }
}

// Question words and Hinglish glue carry no signal — matching on them scores
// every turn equally, which is the same as matching on nothing.
const STOP = new Set(
  ("the and for was were what when who whom where why how did does you your yours this that with " +
    "about from have has had can could would should tell told say said give given about " +
    "kya kaun kab kaise kahan kyun kyu mera meri mere mujhe tumne aapne tha thi thay hai hain " +
    "kar karo karke bata batao bola bolo diya dena wala wali").split(/\s+/)
);

const tokenize = (s) => [
  ...new Set(
    String(s || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  ),
];

/**
 * The turns worth putting back in front of the model: keyword matches for the
 * question being asked, plus the last few turns regardless — "kal kya bola tha"
 * has nothing to match on but is exactly the question this exists to answer.
 *
 * `exclude` is the user text already in the live message list, so the same
 * exchange isn't paid for twice in one prompt.
 */
export async function recallTurns(query, { limit = 5, recent = 3, exclude = [] } = {}) {
  const turns = await readTurns().catch(() => []);
  if (!turns.length) return [];

  const seen = new Set(
    (exclude || []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean)
  );
  const fresh = turns.filter((t) => !seen.has(String(t.user || "").trim().toLowerCase()));

  const words = tokenize(query);
  const matched = words.length
    ? fresh
        .map((t) => {
          const hay = `${t.user} ${t.reply} ${(t.tools || []).join(" ")}`.toLowerCase();
          return { t, score: words.filter((w) => hay.includes(w)).length };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || String(b.t.at).localeCompare(String(a.t.at)))
        .slice(0, limit)
        .map((x) => x.t)
    : [];

  // slice(-0) is slice(0) — the whole transcript. Guard it.
  const tail = recent > 0 ? fresh.slice(-recent).filter((t) => !matched.includes(t)) : [];
  return [...matched, ...tail].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Prompt-ready block, or "" when there is nothing to recall. */
export async function conversationBlock(query, opts) {
  const turns = await recallTurns(query, opts);
  if (!turns.length) return "";
  const lines = turns
    .map((t) => {
      const when = String(t.at).slice(0, 16).replace("T", " ");
      const tools = (t.tools || []).length
        ? `\n  [tools you ran: ${t.tools.join("; ").slice(0, 240)}]`
        : "";
      return `- ${when} (${t.surface}) founder: ${String(t.user).slice(0, 400)}\n  you: ${String(t.reply).slice(0, 400)}${tools}`;
    })
    .join("\n");
  return (
    `\n\nEARLIER CONVERSATIONS with the founder (durable transcript across the dashboard, overlay, ` +
    `WhatsApp and voice — these really happened, treat them as fact and never claim you don't remember ` +
    `something that is in here):\n${lines}`
  );
}
