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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, "..", "..", "auth_info_baileys");

let sock = null;
let stopped = false;
const status = { enabled: false, connected: false, qr: null, me: null };

// Rolling per-chat history so a WhatsApp conversation keeps context like the
// dashboard chat does. Kept in memory only — a restart starts the thread fresh.
const histories = new Map(); // jid -> [{role, content}]
const replying = new Set(); // jids with a reply in flight

// runSecretaryChat can close apps, lock the laptop and read files. Anyone who
// knows the number could otherwise drive all of that by text, so the bot answers
// ONLY numbers listed in WHATSAPP_ALLOWED_NUMBERS (comma-separated, digits only,
// country code included). Unset = the bot connects but answers nobody.
function allowedNumbers() {
  return String(process.env.WHATSAPP_ALLOWED_NUMBERS || "")
    .split(",")
    .map((n) => n.replace(/\D/g, ""))
    .filter(Boolean);
}

function isAllowed(jid) {
  const num = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  return allowedNumbers().includes(num);
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

  if (!isAllowed(jid)) {
    console.warn(`[whatsapp] ignored message from ${jid} — add its number to WHATSAPP_ALLOWED_NUMBERS to let it through`);
    return;
  }
  // Without this a slow reply lets the next message start a second brain run for
  // the same chat, and both answer.
  if (replying.has(jid)) return;
  replying.add(jid);

  try {
    await sock.sendPresenceUpdate("composing", jid);
    const history = histories.get(jid) || [];
    history.push({ role: "user", content: text });

    const { message } = await runSecretaryChat(history.slice(-10));
    history.push({ role: "assistant", content: message });
    histories.set(jid, history.slice(-10));

    await sock.sendMessage(jid, { text: message });
    console.log(`[whatsapp] replied to ${jid}`);
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
      if (!allowedNumbers().length) {
        console.warn("[whatsapp] WHATSAPP_ALLOWED_NUMBERS is empty — the bot will not answer anyone. Set it in .env (e.g. 919876543210).");
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
  return { ...status, allowed: allowedNumbers().length };
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
