// WhatsApp bot — AYUS answers direct messages on the founder's own number.
//
// Baileys drives the real WhatsApp Web protocol: first launch prints a QR in the
// terminal, and the pairing is saved under auth_info_baileys/ so later launches
// reconnect silently. Incoming text goes through the SAME brain as the dashboard
// (runSecretaryChat), so tools, memory and persona are identical.
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import qrcode from "qrcode-terminal";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { runSecretaryChat } from "./secretaryAgent.js";
import { founderPhone } from "./contacts.js";
import { llmJSON } from "./llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, "..", "..", "auth_info_baileys");

let sock = null;
let stopped = false;
const status = { enabled: false, connected: false, qr: null, me: null };

// Rolling per-chat history so a WhatsApp conversation keeps context like the
// dashboard chat does. Kept in memory only — a restart starts the thread fresh.
const histories = new Map(); // jid -> [{role, content}]
const replying = new Set(); // jids with a reply in flight

// Everyone who messages AYUS gets a reply. Only the founder's own number gets
// the real brain, though — runSecretaryChat can close apps, lock the laptop,
// read files and WhatsApp people as him, and a stranger must not drive that by
// text. Everyone else lands on publicReply below.
//
// founderPhone() normalizes: the .env held a 10-digit number while WhatsApp jids
// carry the country code, so the old comparison matched nobody and the bot
// silently answered no one at all — including the founder.
function isFounder(jid) {
  const num = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  const mine = founderPhone();
  return Boolean(mine) && num === mine;
}

// Strangers get a receptionist with no tools and no company data — a polite
// front desk, not the command console.
async function publicReply(history) {
  const out = await llmJSON({
    system:
      "You are AYUS, the AI assistant of AYUS Labs, replying on WhatsApp to someone who is NOT the founder " +
      "(Anish). Be warm, brief (1-3 sentences) and professional; mirror their language, Hinglish included. " +
      "You can talk about AYUS Labs in general terms and take a message for Anish. You CANNOT do anything " +
      "else — no laptop control, no files, no sending messages to other people, no internal or financial " +
      "details. If asked for those, say Anish will get back to them. Never claim to have done a task.",
    prompt: history.map((m) => `${m.role === "user" ? "Them" : "You"}: ${m.content}`).join("\n"),
    schema: {
      type: "object",
      properties: { reply: { type: "string", description: "The WhatsApp reply to send" } },
      required: ["reply"],
    },
    maxTokens: 300,
  });
  return String(out?.reply || "").trim() || "Thanks for the message — I've noted it for Anish, he'll get back to you.";
}

function textOf(msg) {
  const m = msg.message;
  if (!m) return "";
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || "";
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  // Groups, status broadcasts and our own echoes are never conversation turns.
  if (!jid || msg.key.fromMe || jid.endsWith("@g.us") || jid === "status@broadcast") return;

  const text = textOf(msg).trim();
  if (!text) return;

  const trusted = isFounder(jid);
  // Without this a slow reply lets the next message start a second brain run for
  // the same chat, and both answer.
  if (replying.has(jid)) return;
  replying.add(jid);

  try {
    await sock.sendPresenceUpdate("composing", jid);
    const history = histories.get(jid) || [];
    history.push({ role: "user", content: text });

    const message = trusted
      ? (await runSecretaryChat(history.slice(-10), { surface: "whatsapp" })).message
      : await publicReply(history.slice(-6));
    history.push({ role: "assistant", content: message });
    histories.set(jid, history.slice(-10));

    await sock.sendMessage(jid, { text: message });
    console.log(`[whatsapp] replied to ${jid}${trusted ? "" : " (public mode)"}`);
  } catch (err) {
    console.error("[whatsapp] reply failed:", err?.message || err);
    try {
      await sock.sendMessage(jid, { text: "Sorry sir — I hit an error on that one. Try again in a moment." });
    } catch {
      /* the socket is gone too; the reconnect below will pick it up */
    }
  } finally {
    replying.delete(jid);
    sock?.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}

export async function initWhatsAppBot() {
  if (process.env.WHATSAPP_BOT_ENABLED !== "true") return;
  status.enabled = true;
  stopped = false;
  console.log("[whatsapp] Initializing WhatsApp client...");

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({
    auth: state,
    // Baileys is chatty at info level and drowns the server log.
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false, // don't steal "online" from the founder's phone
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      status.qr = qr;
      console.log("[whatsapp] Scan this QR with WhatsApp → Settings → Linked devices:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      status.connected = true;
      status.qr = null;
      status.me = sock.user?.id || null;
      console.log("========================================================");
      console.log("[whatsapp] ✅ AYUS WhatsApp Bot connected successfully!");
      console.log("========================================================");
      if (!founderPhone()) {
        console.warn("[whatsapp] FOUNDER_NUMBER is not set — everyone, including you, gets the tool-less receptionist. Put your number in .env (e.g. 919876543210) to reach the real brain.");
      }
    }
    if (connection === "close") {
      status.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      // Logged out means the pairing was revoked from the phone — reconnecting
      // just loops. Everything else (restart required, timeout, network) retries.
      const retry = !stopped && code !== DisconnectReason.loggedOut;
      console.log(`[whatsapp] Connection closed. Reason: ${code ?? "Unknown"}. Reconnecting: ${retry}`);
      if (retry) setTimeout(() => initWhatsAppBot().catch((e) => console.error("[whatsapp] reconnect failed:", e?.message || e)), 3000);
      else if (code === DisconnectReason.loggedOut) console.warn(`[whatsapp] Logged out — delete ${AUTH_DIR} and restart to pair again.`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return; // 'append' is history sync, not new traffic
    for (const msg of messages) await handleMessage(msg);
  });
}

export function getWhatsAppStatus() {
  return { ...status, founder: founderPhone() || null };
}

export async function sendWhatsAppMessage(to, text) {
  if (!sock || !status.connected) throw new Error("WhatsApp bot is not connected");
  const digits = String(to).replace(/\D/g, "");
  if (!digits) throw new Error("invalid WhatsApp number");
  const jid = String(to).includes("@") ? String(to) : `${digits}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: String(text) });
  return { ok: true, to: jid };
}

export async function closeWhatsAppBot() {
  stopped = true;
  try {
    // end(), not logout() — logout revokes the pairing and forces a new QR scan.
    sock?.end(undefined);
  } catch {
    /* already gone */
  }
  sock = null;
  status.connected = false;
}
