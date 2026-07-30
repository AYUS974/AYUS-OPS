import "./lib/ca.js"; // trust Avast's MITM CA before any HTTPS call (must be first)
import "dotenv/config";
import express from "express";
import cron from "node-cron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "./lib/supabase.js";
import { executeAction } from "./lib/executor.js";
import { requireAuth, verifyToken, UNREACHABLE } from "./lib/auth.js";
import { runAll } from "./orchestrator.js";
import {
  runSecretaryChat,
  runSecretaryChatGroq,
  runSecretaryChatStream,
  runSecretaryChatGlm,
  runSecretaryChatGlmStream,
  SYSTEM,
  CHAT_TOOL_DECLS,
  GOOGLE_READ_TOOLS,
  REMEMBER_TOOL,
  PROPOSE_TOOL,
  SPOTIFY_TOOL,
  execTool,
  companySnapshot,
  toolEventLine,
} from "./lib/secretaryAgent.js";
import { logTurn } from "./lib/transcript.js";
import { PC_TOOL_DECLARATIONS } from "./lib/pc-tools.js";
import { learnFromDecision } from "./lib/memory.js";
import { dispatchHandoffs } from "./lib/handoffs.js";
import { notify, esc } from "./lib/notify.js";
import { buildAnalytics } from "./lib/analytics.js";
import { googleRouter, googleCallback, isGoogleConnected, listRecentEmails } from "./lib/google.js";
import { listInbox, scanInboxForLeads, scanInboxForLeadsStream } from "./lib/inbox.js";
import { spotifyRouter, spotifyCallback } from "./lib/spotify.js";
import { missionsRouter } from "./lib/missions/routes.js";
import { recoverMissions } from "./lib/missions/engine.js";
import { workflowsRouter } from "./lib/workflows/routes.js";
import { reloadSchedules } from "./lib/workflows/schedule.js";
import { runWorkflow } from "./lib/workflows/engine.js";
import { getWorkflowByEventToken } from "./lib/workflows/store.js";
import { groqTranscribe } from "./lib/groq.js";
import { edgeTTS } from "./lib/edge-tts.js";
import { getVaultGraph, getVaultNote, getDocsCatalog, getDocBody, searchDocs } from "./lib/vault.js";
import { initWhatsAppBot, getWhatsAppStatus, sendWhatsAppMessage, closeWhatsAppBot } from "./lib/whatsapp.js";
import { listContacts, saveContact, deleteContact, findContact } from "./lib/contacts.js";
import { listNotes, saveNote, deleteNote, listProjects } from "./lib/notes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A stray async rejection — most often a transient Avast-MITM TLS blip on an
// outbound fetch (Supabase/Groq/Google) — must never take the whole server
// down. Log it and keep serving; the next request just retries.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", String(reason?.stack || reason?.message || reason).split("\n")[0]);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", String(err?.stack || err?.message || err).split("\n")[0]);
});

const app = express();
app.disable("x-powered-by");
// 12mb: chat turns can carry a base64 screenshot (m.image) inline. Full-res
// multi-monitor PNGs get big; anything smaller 413s the screen-grab path.
// ponytail: global bump; scope to the chat route if other routes ever need to stay tight.
app.use(express.json({ limit: "12mb" }));

// ---------- Public endpoints ----------

// Health check for Render/Railway
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// The React app fetches its Supabase config from here, so the frontend
// needs no build-time env vars. The anon key is public by design — all
// real authorization happens via Supabase Auth sessions + requireAuth.
app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    geminiLiveEnabled: process.env.GEMINI_LIVE_ENABLED === "true",
    // Porcupine keyword interrupt. Picovoice access keys are client-side by
    // design (usage-metered, not a secret). Empty string → feature stays off.
    picovoiceKey: process.env.PICOVOICE_ACCESS_KEY || "",
  });
});

// Google OAuth callback is public — Google redirects the browser here with no
// auth header. Registered before the authenticated /api router so it matches first.
app.get("/api/google/callback", googleCallback);
app.get("/api/spotify/callback", spotifyCallback);

// Public webhook that fires an "event"-triggered workflow. External callers have
// no auth session, so the per-workflow token IS the authorization for this one
// endpoint. The request body becomes the workflow's trigger payload.
app.post("/api/workflows/hook/:token", async (req, res) => {
  try {
    const wf = await getWorkflowByEventToken(String(req.params.token || ""));
    if (!wf) return res.status(404).json({ error: "no active workflow for this token" });
    runWorkflow(wf, { triggerType: "event", payload: req.body || {} }).catch((err) =>
      console.error(`[workflows] webhook run of ${wf.id} crashed: ${err?.message || err}`)
    );
    res.status(202).json({ ok: true, workflow: wf.name });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/debug-db", async (req, res) => {
  try {
    const { data: missions, error } = await db.from("missions").select("*").order("created_at", { ascending: false }).limit(5);
    if (error) throw error;
    res.json({ missions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const api = express.Router();
api.use(requireAuth);

// Chat with AYUS (the operations intelligence / personal secretary). It has real
// tools: open apps, play music, search/read files in allowed folders, draft proposals.
// Anything destructive is impossible by design — those become approval items.
api.post("/secretary/chat", async (req, res) => {
  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  try {
    // Groq is much faster than Gemini's rate-limited free tier — use it for AYUS
    // chat whenever a key is set, so replies feel close to real-time. But Groq's
    // free tier also throttles (429 "rate limit reached"); when it does, fall
    // back to Gemini so AYUS stays responsive instead of dead-ending.
    let result;
    const provider = (process.env.LLM_PROVIDER || "").toLowerCase();
    // Screen-grab chats carry an image. Only the Gemini path is multimodal, so
    // route any image-bearing turn there regardless of the configured provider.
    const hasImage = messages.some((m) => m && m.image);

    if (hasImage || provider === "gemini") {
      try {
        result = await runSecretaryChat(messages);
      } catch (gemErr) {
        // Gemini's free tier is 20 requests/DAY on some models — once it's spent,
        // every chat 404s the founder. Text turns fall through to Groq/GLM;
        // image turns can't (only the Gemini path is multimodal here).
        console.warn("[secretary] Gemini chat failed:", String(gemErr.message || gemErr).slice(0, 160));
        if (hasImage) throw gemErr;
        if (process.env.GROQ_API_KEY) result = await runSecretaryChatGroq(messages);
        else if (process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY) result = await runSecretaryChatGlm(messages);
        else throw gemErr;
      }
    } else if (provider === "glm" && (process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY)) {
      try {
        result = await runSecretaryChatGlm(messages);
      } catch (glmErr) {
        console.warn("[secretary] GLM chat failed — falling back to Groq/Gemini:", glmErr.message);
        if (process.env.GROQ_API_KEY) {
          try {
            result = await runSecretaryChatGroq(messages);
          } catch (groqErr) {
            result = await runSecretaryChat(messages);
          }
        } else {
          result = await runSecretaryChat(messages);
        }
      }
    } else if (process.env.GROQ_API_KEY) {
      try {
        result = await runSecretaryChatGroq(messages);
      } catch (groqErr) {
        if (!process.env.GEMINI_API_KEY) throw groqErr;
        console.warn(
          "[secretary] Groq chat failed — falling back to Gemini:",
          String(groqErr.message || groqErr).slice(0, 160)
        );
        result = await runSecretaryChat(messages);
      }
    } else {
      result = await runSecretaryChat(messages);
    }

    const { message, toolEvents, suggestedAction } = result;
    res.json({
      message,
      toolEvents,
      hasSuggestion: Boolean(suggestedAction),
      suggestedAction: suggestedAction || undefined,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Streaming chat — same brain as /secretary/chat, but pushes Server-Sent Events
// so the reply appears (and is spoken) token-by-token. Events:
//   {type:"delta", text}  — a chunk of the reply
//   {type:"tool",  line}  — a tool was used
//   {type:"done",  message, toolEvents, hasSuggestion, suggestedAction}
//   {type:"error", error}
api.post("/secretary/chat/stream", async (req, res) => {
  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    let result;
    const provider = (process.env.LLM_PROVIDER || "").toLowerCase();

    if (provider === "gemini") {
      result = await runSecretaryChat(messages);
      sse({ type: "delta", text: result.message });
    } else if (provider === "glm" && (process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY)) {
      try {
        result = await runSecretaryChatGlmStream(messages, {
          onDelta: (text) => sse({ type: "delta", text }),
          onToolEvent: (line) => sse({ type: "tool", line }),
        });
      } catch (glmErr) {
        console.warn("[secretary] GLM stream failed — falling back to non-streaming Gemini/Groq:", glmErr.message);
        if (process.env.GROQ_API_KEY) {
          try {
            result = await runSecretaryChatGroq(messages);
            sse({ type: "delta", text: result.message });
          } catch (groqErr) {
            result = await runSecretaryChat(messages);
            sse({ type: "delta", text: result.message });
          }
        } else {
          result = await runSecretaryChat(messages);
          sse({ type: "delta", text: result.message });
        }
      }
    } else if (process.env.GROQ_API_KEY) {
      try {
        result = await runSecretaryChatStream(messages, {
          onDelta: (text) => sse({ type: "delta", text }),
          onToolEvent: (line) => sse({ type: "tool", line }),
        });
      } catch (groqErr) {
        if (!process.env.GEMINI_API_KEY) throw groqErr;
        console.warn(
          "[secretary] Groq stream failed — falling back to Gemini:",
          String(groqErr.message || groqErr).slice(0, 160)
        );
        result = await runSecretaryChat(messages);
        sse({ type: "delta", text: result.message });
      }
    } else {
      result = await runSecretaryChat(messages);
      sse({ type: "delta", text: result.message });
    }

    sse({
      type: "done",
      message: result.message,
      toolEvents: result.toolEvents || [],
      hasSuggestion: Boolean(result.suggestedAction),
      suggestedAction: result.suggestedAction || null,
    });
    res.end();
  } catch (err) {
    sse({ type: "error", error: String(err.message || err) });
    res.end();
  }
});

// Text-to-speech: Sarvam (primary) → Cartesia → ElevenLabs → 404, in which
// case the browser falls back to its built-in speechSynthesis voices (free).
// Sarvam's Bulbul model is purpose-built for Indian languages and handles
// Hinglish code-switching natively (Hindi↔English in a single pass), so it's
// the best fit for AYUS's mixed-language replies.
const SARVAM_VOICES = {
  // bulbul:v3 speakers matched to each agent's personality; override in .env.
  ayus: process.env.SARVAM_VOICE_AYUS || "priya", // composed female assistant — JARVIS-style
  sales: process.env.SARVAM_VOICE_SALES || "rahul", // friendly, upbeat male
  finance: process.env.SARVAM_VOICE_FINANCE || "shreya", // decisive female
  marketing: process.env.SARVAM_VOICE_MARKETING || "aditya", // warm, engaging male
  hr: process.env.SARVAM_VOICE_HR || "neha", // friendly female
  cto: process.env.SARVAM_VOICE_CTO || "shubh", // deep, thoughtful male
};

const CARTESIA_VOICES = {
  // Indian-accent (Hindi/Hinglish) voices matched to each agent's personality; override in .env.
  ayus: process.env.CARTESIA_VOICE_AYUS || "0f14d8cb-f039-41fe-a813-a9b4bee7eed8", // Nisha — elegant female, composed JARVIS-style
  sales: process.env.CARTESIA_VOICE_SALES || "910fb75e-1d20-4840-ac63-ac6b26a71bdc", // Dev — friendly host, cheerful
  finance: process.env.CARTESIA_VOICE_FINANCE || "432fc642-6a83-4975-b77a-c605903b5ba6", // Sanya — modern, decisive
  marketing: process.env.CARTESIA_VOICE_MARKETING || "7e8cb11d-37af-476b-ab8f-25da99b18644", // Anuj — engaging narrator, warm
  hr: process.env.CARTESIA_VOICE_HR || "47f3bbb1-e98f-4e0c-92c5-5f0325e1e206", // Neha — virtual assistant, friendly
  cto: process.env.CARTESIA_VOICE_CTO || "6b7468f5-d6b0-4d6b-b38a-46f6d6e5bac7", // Rakesh — thoughtful, deep thinker
};

const ELEVEN_VOICES = {
  ayus: process.env.ELEVENLABS_VOICE_AYUS || "pNInz6obpgDQGcFmaJgB", // Adam — deep male, JARVIS-style
  sales: process.env.ELEVENLABS_VOICE_SALES || "TxGEqnHWrfWFTfGW9XjX",
  finance: process.env.ELEVENLABS_VOICE_FINANCE || "EXAVITQu4vr4xnSDxMaL",
  marketing: process.env.ELEVENLABS_VOICE_MARKETING || "ErXwobaYiN019PkySvjV",
  hr: process.env.ELEVENLABS_VOICE_HR || "MF3mGyEYCl7XYWbV9V6O",
  cto: process.env.ELEVENLABS_VOICE_CTO || "VR6AewLTigWG4xSOukaG",
};

async function sarvamTTS(text, agent) {
  const r = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": process.env.SARVAM_API_KEY,
    },
    body: JSON.stringify({
      text,
      model: process.env.SARVAM_MODEL || "bulbul:v3",
      speaker: SARVAM_VOICES[agent] || SARVAM_VOICES.ayus,
      target_language_code: "hi-IN", // Hindi/Hinglish — Bulbul code-switches natively
      output_audio_codec: "mp3",
      speech_sample_rate: "44100",
    }),
  });
  if (!r.ok) throw new Error(`Sarvam ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const { audios } = await r.json();
  if (!audios?.[0]) throw new Error("Sarvam returned no audio");
  return Buffer.from(audios[0], "base64");
}

async function cartesiaTTS(text, agent) {
  const r = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.CARTESIA_API_KEY,
      "Cartesia-Version": "2024-11-13",
    },
    body: JSON.stringify({
      model_id: "sonic-3",
      transcript: text,
      voice: { mode: "id", id: CARTESIA_VOICES[agent] || CARTESIA_VOICES.ayus },
      output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
      language: "hi", // Hindi/Hinglish — Indian-accent voices speak mixed text best
    }),
  });
  if (!r.ok) throw new Error(`Cartesia ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function elevenLabsTTS(text, agent) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICES[agent] || ELEVEN_VOICES.ayus}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    }
  );
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

api.post("/tts", async (req, res) => {
  const { text, agent } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: "text required" });
  const clean = String(text).slice(0, 800);

  try {
    let audio;
    if (process.env.SARVAM_API_KEY) audio = await sarvamTTS(clean, agent);
    else if (process.env.CARTESIA_API_KEY) audio = await cartesiaTTS(clean, agent);
    else if (process.env.ELEVENLABS_API_KEY) audio = await elevenLabsTTS(clean, agent);
    else {
      // Edge-TTS: free, no API key — natural Hindi/English voices from
      // Microsoft Edge's public TTS service. Falls through to 502 → browser
      // voices only if Edge-TTS itself fails (network down, etc.).
      try {
        audio = await edgeTTS(clean, agent);
      } catch (edgeErr) {
        console.warn("[tts] Edge-TTS failed:", String(edgeErr.message || edgeErr).slice(0, 120));
        return res.status(502).json({ error: "no TTS provider available" });
      }
    }

    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    // Paid provider failed — try Edge-TTS as rescue fallback before giving up.
    try {
      const rescue = await edgeTTS(clean, agent);
      res.set("Content-Type", "audio/mpeg");
      return res.send(rescue);
    } catch { /* fall through */ }
    // 502 → the browser voice fallback kicks in client-side
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Speech-to-text: the browser records an utterance and POSTs the raw audio
// bytes here; Groq's Whisper transcribes it. Works in every browser (unlike
// the Chromium-only Web Speech API). express.raw buffers the audio body —
// the global express.json above ignores non-JSON content types, so the
// stream reaches us intact.
api.post(
  "/stt",
  express.raw({ type: ["audio/*", "application/octet-stream"], limit: "15mb" }),
  async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
      return res.status(404).json({ error: "no STT provider configured" });
    }
    const audio = req.body;
    if (!audio?.length) return res.status(400).json({ error: "audio required" });

    try {
      const ext = String(req.query.ext || "webm").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "webm";
      const text = await groqTranscribe(audio, {
        filename: `speech.${ext}`,
        language: process.env.GROQ_STT_LANGUAGE || undefined,
        prompt:
          process.env.GROQ_STT_PROMPT ||
          "AYUS, Arjun, Meera, Kabir, Isha, Vikram. The founder speaks Hinglish — a casual mix of Hindi and English.",
      });
      res.json({ text });
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
  }
);

// Propose a new action (e.g. from Secretary Chat)
api.post("/actions/propose", async (req, res) => {
  const { type, title, summary, payload } = req.body || {};
  if (!type || !title) {
    return res.status(400).json({ error: "type and title are required" });
  }

  try {
    const { data, error } = await db
      .from("pending_actions")
      .insert({
        agent: "secretary",
        type,
        title,
        summary,
        payload: payload || {},
        status: "pending"
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    res.json({ ok: true, action: data });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Everything the dashboard needs in one call
api.get("/overview", async (_req, res) => {
  try {
    const [actions, digest, runs, newLeads, unpaid] = await Promise.all([
      db
        .from("pending_actions")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      db.from("daily_digests").select("*").order("created_at", { ascending: false }).limit(1),
      db.from("agent_runs").select("*").order("created_at", { ascending: false }).limit(8),
      db.from("leads").select("*", { count: "exact", head: true }).eq("status", "new"),
      db.from("invoices").select("amount,currency").eq("status", "unpaid"),
    ]);

    for (const r of [actions, digest, runs, unpaid]) {
      if (r.error) throw new Error(r.error.message);
    }

    const unpaidRows = unpaid.data || [];
    res.json({
      running: runInFlight,
      actions: actions.data || [],
      digest: digest.data?.[0] || null,
      runs: runs.data || [],
      stats: {
        newLeads: newLeads.count ?? 0,
        unpaidCount: unpaidRows.length,
        unpaidTotal: unpaidRows.reduce((sum, inv) => sum + Number(inv.amount || 0), 0),
        currency: unpaidRows[0]?.currency || "INR",
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Company analytics for the Insights tab — pipeline, revenue, activity, health.
api.get("/analytics", async (_req, res) => {
  try {
    res.json(await buildAnalytics());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Proactive alerts — things AYUS should flag the moment they happen (overdue
// invoices, important unread mail). The frontend polls this every ~90s, dedupes
// by alert id, and has AYUS speak/toast anything new. Each branch is isolated so
// one failing source (e.g. Google) never blanks the others.
api.get("/proactive", async (_req, res) => {
  const alerts = [];

  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: invoices } = await db
      .from("invoices")
      .select("id,client_name,amount,currency,due_date,status")
      .eq("status", "unpaid")
      .lt("due_date", today);
    for (const inv of invoices || []) {
      const days = Math.max(
        1,
        Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86_400_000)
      );
      alerts.push({
        id: `invoice:${inv.id}`,
        kind: "invoice_overdue",
        severity: days >= 7 ? "high" : "medium",
        title: `Invoice overdue — ${inv.client_name || "client"}`,
        message: `${inv.client_name || "A client"}'s invoice of ${inv.amount} ${inv.currency || "INR"} is ${days} day${days === 1 ? "" : "s"} overdue.`,
        speak: `Heads up, sir — ${inv.client_name || "a client"}'s invoice of ${inv.amount} ${inv.currency || "rupees"} is ${days} day${days === 1 ? "" : "s"} overdue.`,
      });
    }
  } catch {
    /* invoice source unavailable — skip, keep other alerts */
  }

  try {
    if (await isGoogleConnected()) {
      const emails = await listRecentEmails({ q: "is:unread is:important newer_than:2d", maxResults: 5 });
      for (const m of emails || []) {
        const sender = (m.from || "someone").replace(/<.*?>/, "").trim();
        alerts.push({
          id: `mail:${m.id}`,
          kind: "important_email",
          severity: "medium",
          title: `Important email — ${sender}`,
          message: `${m.subject || "(no subject)"} — from ${sender}.`,
          speak: `New important email from ${sender}: ${m.subject || "no subject"}.`,
        });
      }
    }
  } catch {
    /* Google momentarily unavailable — skip */
  }

  res.json({ alerts, ts: new Date().toISOString() });
});

// Mission Engine — the autonomous org: founder objective → CEO → Planner →
// specialists → QA → Reviewer → deliverable. Scoped to the signed-in founder.
api.use("/missions", missionsRouter);

// Workflow Automation — trigger (manual/schedule/event) → ordered steps over
// AYUS's own primitives (missions, LLM, approvals, notify, HTTP). Scoped to the
// signed-in founder.
api.use("/workflows", workflowsRouter);

// Google (Gmail + Calendar) connect/status/disconnect lives on its own router.
api.use("/google", googleRouter);

// Lead Pipeline — the founder's inbox as a live list, plus an AI "Scan inbox →
// leads" action that reads recent mail, decides who is a genuine prospect, and
// adds only those to the pipeline. Reads are safe; the scan is founder-triggered.
api.get("/inbox", async (_req, res) => {
  try {
    if (!(await isGoogleConnected())) return res.json({ connected: false, emails: [] });
    const emails = await listInbox({ maxResults: 20 });
    res.json({ connected: true, emails });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/inbox/scan", async (req, res) => {
  try {
    if (!(await isGoogleConnected())) {
      return res.status(400).json({ error: "Google not connected — connect Google first." });
    }
    const out = await scanInboxForLeads({ maxResults: Number(req.body?.maxResults) || 20 });
    if (!out.ok) return res.status(500).json({ error: out.error });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Streaming variant of the scan above: qualifies senders one at a time,
// most-recent-first, and pushes an SSE event the instant each one lands (or is
// skipped) instead of waiting for the whole inbox to be analysed before replying.
api.post("/inbox/scan/stream", async (req, res) => {
  if (!(await isGoogleConnected())) {
    return res.status(400).json({ error: "Google not connected — connect Google first." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    await scanInboxForLeadsStream({ maxResults: Number(req.body?.maxResults) || 20 }, sse);
  } catch (err) {
    sse({ type: "error", error: String(err.message || err) });
  } finally {
    res.end();
  }
});

// Knowledge Vault endpoints — second brain graph & markdown inspector from F:\ANISH
api.get("/vault/graph", async (_req, res) => {
  try {
    const graph = await getVaultGraph();
    res.json(graph);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/vault/note", async (req, res) => {
  try {
    const noteIdOrPath = String(req.query.path || req.query.id || "");
    if (!noteIdOrPath) return res.status(400).json({ error: "path or id query parameter required" });
    const note = await getVaultNote(noteIdOrPath);
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Documentation library — every markdown doc mirrored out of the repos into
// <vault>\Docs. Catalog is small; bodies are fetched one at a time.
api.get("/vault/docs", async (_req, res) => {
  try {
    res.json(await getDocsCatalog());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/vault/docs/search", async (req, res) => {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 50);
    res.json(await searchDocs(String(req.query.q || ""), limit));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/vault/doc", async (req, res) => {
  try {
    const project = String(req.query.p || "");
    const rel = String(req.query.r || "");
    if (!project || !rel) return res.status(400).json({ error: "p and r query parameters required" });
    res.json(await getDocBody(project, rel));
  } catch (err) {
    const msg = String(err.message || err);
    const bad = msg.includes("outside the docs folder") || msg.includes("not a markdown file");
    res.status(bad ? 400 : 404).json({ error: bad ? msg : "document not found" });
  }
});

api.get("/leads", async (_req, res) => {
  try {
    const { data, error } = await db
      .from("leads")
      .select("id,name,email,status,score,source,ai_notes,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    res.json({ leads: data || [] });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Spotify connect/status/disconnect (real "play this exact song").
api.use("/spotify", spotifyRouter);

// Approve or reject a pending action. Approval executes it immediately.
api.post("/actions/:id/decide", async (req, res) => {
  const { id } = req.params;
  const { decision, reason } = req.body || {}; // 'approved' | 'rejected', optional reason note

  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }

  try {
    const { data: action, error } = await db
      .from("pending_actions")
      .select("*")
      .eq("id", id)
      .eq("status", "pending")
      .single();
    if (error || !action) throw new Error("action not found or already decided");

    const now = new Date().toISOString();

    if (decision === "rejected") {
      await db.from("pending_actions").update({ status: "rejected", decided_at: now }).eq("id", id);
      // The agent learns from the rejection so it won't repeat the pattern.
      learnFromDecision(action, "rejected", reason).catch(() => {});
      return res.json({ ok: true, status: "rejected" });
    }

    await db.from("pending_actions").update({ status: "approved", decided_at: now }).eq("id", id);
    try {
      await executeAction(action);
      await db
        .from("pending_actions")
        .update({ status: "executed", executed_at: new Date().toISOString() })
        .eq("id", id);

      // Learn + cascade work to the next department (best-effort, non-blocking).
      learnFromDecision(action, "approved", reason).catch(() => {});
      const handoffs = await dispatchHandoffs(action);
      if (handoffs.length) {
        const lines = handoffs.map((h) => `• ${esc(h.title)}`).join("\n");
        notify(`✅ <b>${esc(action.title)}</b> approved.\nNext up:\n${lines}`, {
          urgent: handoffs.some((h) => h.urgent),
        }).catch(() => {});
      }

      res.json({ ok: true, status: "executed", handoffs });
    } catch (execErr) {
      await db.from("pending_actions").update({ status: "failed" }).eq("id", id);
      res.status(500).json({ error: `execution failed: ${String(execErr.message || execErr)}` });
    }
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Manual trigger — same thing the cron does. Guarded so two clicks (or a
// click during the cron run) can't double-spend LLM calls.
let runInFlight = false;
api.post("/run", async (_req, res) => {
  if (runInFlight) return res.status(409).json({ error: "a run is already in progress" });
  runInFlight = true;
  try {
    const results = await runAll();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    runInFlight = false;
  }
});

// WhatsApp bot: connection state (for a "connected / scan the QR" badge) and a
// manual send. Both sit behind requireAuth like every other /api route.
api.get("/whatsapp/status", (_req, res) => res.json(getWhatsAppStatus()));

api.post("/whatsapp/send", async (req, res) => {
  const { to, name, message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message is required" });
  try {
    // `name` looks the number up in the contact book; `to` is the raw number.
    let number = to;
    if (!number) {
      const found = await findContact(name);
      if (!found.ok) return res.status(400).json({ error: found.error });
      number = found.contact.phone;
    }
    res.json(await sendWhatsAppMessage(number, message));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------- Contacts (name → phone, used by whatsapp_send) ----------
api.get("/contacts", async (_req, res) => {
  try {
    res.json({ contacts: await listContacts() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/contacts", async (req, res) => {
  try {
    res.json({ contact: await saveContact(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

api.delete("/contacts/:id", async (req, res) => {
  try {
    res.json(await deleteContact(req.params.id));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

// ---------- Notes (project working memory; AYUS writes here too) ----------
api.get("/notes", async (req, res) => {
  try {
    const [notes, projects] = await Promise.all([
      listNotes({ project: String(req.query.project || ""), q: String(req.query.q || "") }),
      listProjects(),
    ]);
    res.json({ notes, projects });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/notes", async (req, res) => {
  try {
    res.json({ note: await saveNote(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

api.delete("/notes/:id", async (req, res) => {
  try {
    res.json(await deleteNote(req.params.id));
  } catch (err) {
    res.status(404).json({ error: String(err.message || err) });
  }
});

app.use("/api", api);

// ---------- Frontend (built React app) ----------

const webDist = path.join(__dirname, "..", "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA fallback — let React Router-less client handle any non-API path
  app.get(/^\/(?!api\/|healthz).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .status(503)
      .send("Frontend not built. Run: npm run build (or `npm run dev` during development).");
  });
}

// ---------- Schedule ----------

const schedule = process.env.DAILY_CRON || "0 9 * * *";
cron.schedule(schedule, async () => {
  if (runInFlight) return console.log("[cron] skipped — a run is already in progress");
  runInFlight = true;
  try {
    await runAll();
  } catch (err) {
    console.error("[cron] run failed:", err);
  } finally {
    runInFlight = false;
  }
});

// ---------- WebSocket Server for Gemini Multimodal Live API ----------
const wss = new WebSocketServer({ noServer: true });

// Tools that take long enough that blocking the model on them kills the
// conversation (a research report is 30s+). Declared NON_BLOCKING to Gemini:
// it acknowledges out loud, keeps chatting, and speaks the result when the
// response lands with scheduling INTERRUPT.
const NON_BLOCKING_TOOLS = new Set(["delegate_to_researcher"]);

wss.on("connection", async (ws, request) => {
  console.log("[ws] Client connected to live audio socket");
  
  const inFlight = new Set(); // NON_BLOCKING tools currently running for this socket
  let lastUser = ""; // founder's latest spoken turn, from Live input transcription
  let userTurnDone = false;
  // Live has no request/response to wrap, so the turn is assembled from the two
  // transcription streams and filed when Gemini says the turn is complete —
  // otherwise everything said by voice is forgotten the moment the socket closes.
  let lastReply = "";
  let liveTools = [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[ws] GEMINI_API_KEY is not set");
    ws.close(1011, "GEMINI_API_KEY is not set");
    return;
  }

  // Google renames Live models often — use GEMINI_LIVE_MODEL as primary, GEMINI_LIVE_FALLBACK_MODEL as backup.
  const primaryModel = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
  const fallbackModel = process.env.GEMINI_LIVE_FALLBACK_MODEL || "models/gemini-2.5-flash-native-audio-dialog";
  const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

  let currentGeminiWs = null;
  let hasConnected = false;
  let isFallbackAttempted = false;

  function connectGemini(targetModel) {
    console.log(`[ws] Connecting to Gemini Live API with model: ${targetModel}`);
    const geminiWs = new WebSocket(geminiUrl);
    currentGeminiWs = geminiWs;

    // Send the setup config as soon as Gemini connection opens. NOTHING may be
    // awaited in here: `setup` has to be the very first frame Gemini receives,
    // and the browser's mic audio is forwarded the instant this socket is OPEN.
    // Any await lets an audio frame overtake setup → close 1007 "Request
    // contains an invalid argument".
    geminiWs.on("open", () => {
      console.log(`[ws] Gemini Live connection open (${targetModel}). Sending setup config...`);
      hasConnected = true;

      // Helper to uppercase schema types recursively for Gemini validation
      function uppercaseSchemaTypes(schema) {
        if (!schema || typeof schema !== "object") return schema;
        const newSchema = { ...schema };
        if (typeof newSchema.type === "string") {
          newSchema.type = newSchema.type.toUpperCase();
        }
        if (newSchema.properties && typeof newSchema.properties === "object") {
          const newProps = {};
          for (const [key, val] of Object.entries(newSchema.properties)) {
            newProps[key] = uppercaseSchemaTypes(val);
          }
          newSchema.properties = newProps;
        }
        if (newSchema.items && typeof newSchema.items === "object") {
          newSchema.items = uppercaseSchemaTypes(newSchema.items);
        }
        return newSchema;
      }

      // Format tools for Gemini Live API (expects standard tool declarations).
      const rawTools = CHAT_TOOL_DECLS;
      const formattedTools = [
        {
          functionDeclarations: rawTools.map(t => {
            const decl = {
              name: t.name,
              description: t.description,
            };
            if (t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length > 0) {
              decl.parameters = uppercaseSchemaTypes(t.parameters);
            }
            if (NON_BLOCKING_TOOLS.has(t.name)) decl.behavior = "NON_BLOCKING";
            return decl;
          })
        }
      ];

      const setupMsg = {
        setup: {
          model: targetModel,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Aoede" // Or Fenrir, Kore, Puck, Charon
                }
              }
            }
          },
          systemInstruction: {
            parts: [{ text: fullSystemInstruction }]
          },
          tools: formattedTools,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      };

      fs.writeFileSync(path.join(__dirname, "../last-setup.json"), JSON.stringify(setupMsg, null, 2));
      geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Live audio has no message array, so keep the last thing the founder
        // actually said — whatsapp_send refuses to fire without it.
        const heard = msg.serverContent?.inputTranscription?.text;
        if (heard) {
          if (userTurnDone) { lastUser = ""; userTurnDone = false; } // new turn, drop the old ask
          lastUser = (lastUser + heard).slice(-500);
        }
        const spoken = msg.serverContent?.outputTranscription?.text;
        if (spoken) lastReply = (lastReply + spoken).slice(-2000);
        if (msg.serverContent?.turnComplete) {
          userTurnDone = true;
          // Only when AYUS actually said something — a bare turnComplete would
          // otherwise re-file the previous question against an empty answer.
          if (lastReply.trim()) {
            logTurn({ surface: "voice", user: lastUser, reply: lastReply, tools: liveTools });
          }
          lastReply = "";
          liveTools = [];
        }

        // Handle tool call if requested by Gemini
        if (msg.toolCall) {
          const calls = msg.toolCall.functionCalls || [];
          for (const call of calls) {
            const { name, args, id } = call;
            console.log(`[ws] Tool call requested by Gemini: ${name}(${JSON.stringify(args)})`);
            
            const reply = (output) => {
              const response = { output };
              if (NON_BLOCKING_TOOLS.has(name)) response.scheduling = "INTERRUPT";
              if (geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify({ toolResponse: { functionResponses: [{ id, name, response }] } }));
              }
            };

            if (NON_BLOCKING_TOOLS.has(name) && inFlight.has(name)) {
              reply({ ok: true, result: "Already running — do not call this again or check on it. The result will reach you on its own; keep talking to the founder meanwhile." });
              continue;
            }
            if (NON_BLOCKING_TOOLS.has(name)) inFlight.add(name);

            execTool(name, args, { lastUser }).then(async ({ result, suggestedAction }) => {
              // execTool queues proposals itself now — this path only logs them.
              if (suggestedAction) console.log(`[ws] queued proposal: ${suggestedAction.title}`);
              console.log(`[ws] Tool execution result:`, result);
              liveTools.push(toolEventLine(name, args, result));
              reply(result);
            }).catch(err => {
              console.error(`[ws] Tool execution failed:`, err);
              reply({ ok: false, error: String(err.message || err) });
            }).finally(() => inFlight.delete(name));
          }
          return;
        }

        // Forward standard serverContent (contains text / audio) or setupComplete to browser client
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      } catch (err) {
        console.error("[ws] Error parsing/handling Gemini message:", err);
      }
    });

    geminiWs.on("error", (err) => {
      console.error(`[ws] Gemini Live WebSocket error (${targetModel}):`, err);
      if (!hasConnected && !isFallbackAttempted && targetModel !== fallbackModel) {
        isFallbackAttempted = true;
        console.warn(`[ws] Primary live model (${targetModel}) error. Falling back to (${fallbackModel})...`);
        try { geminiWs.close(); } catch {}
        connectGemini(fallbackModel);
        return;
      }
      ws.close(1011, "Gemini connection error");
    });

    geminiWs.on("close", (code, reason) => {
      console.log(`[ws] Gemini Live closed connection (${targetModel}): ${code} - ${reason}`);
      if (!hasConnected && !isFallbackAttempted && targetModel !== fallbackModel) {
        isFallbackAttempted = true;
        console.warn(`[ws] Primary live model (${targetModel}) closed before setup. Falling back to (${fallbackModel})...`);
        connectGemini(fallbackModel);
        return;
      }
      ws.close(code, reason);
    });
  }

  // Built before the Gemini socket exists — companySnapshot() hits Supabase and
  // system_info(), which takes seconds. Doing it inside the open handler let mic
  // audio reach Gemini ahead of `setup`. Shared by the fallback reconnect.
  const fullSystemInstruction = `${SYSTEM}\n\n${await companySnapshot()}`;
  if (ws.readyState !== WebSocket.OPEN) return; // client gave up while we waited

  connectGemini(primaryModel);

  // Client messages from Browser to Browser
  ws.on("message", (data, isBinary) => {
    if (!currentGeminiWs) return;
    if (isBinary) {
      const base64Data = data.toString("base64");
      const audioInputMsg = {
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: base64Data
          }
        }
      };
      if (currentGeminiWs.readyState === WebSocket.OPEN) {
        currentGeminiWs.send(JSON.stringify(audioInputMsg));
      }
    } else {
      try {
        const text = data.toString();
        if (currentGeminiWs.readyState === WebSocket.OPEN) {
          currentGeminiWs.send(text);
        }
      } catch (err) {
        console.error("[ws] Error forwarding text message to Gemini:", err);
      }
    }
  });

  ws.on("error", (err) => {
    console.error("[ws] Browser WebSocket client error:", err);
    if (currentGeminiWs) currentGeminiWs.close();
  });

  ws.on("close", () => {
    console.log("[ws] Client disconnected from live audio socket");
    if (currentGeminiWs) currentGeminiWs.close();
  });
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`AYUS Ops running → http://localhost:${port}`);
  console.log(`Agents scheduled: "${schedule}" (set DAILY_CRON in .env to change)`);
  // Re-pick-up any mission that was mid-flight when the previous process died
  // (nodemon reload / crash / deploy) so it doesn't sit "running" forever.
  recoverMissions().catch((err) => console.error("[missions] recovery failed:", err?.message || err));
  // Register cron jobs for any enabled schedule-triggered workflows.
  reloadSchedules().catch((err) => console.error("[workflows] schedule init failed:", err?.message || err));
  // WhatsApp bot (no-op unless WHATSAPP_BOT_ENABLED=true). First run prints a QR.
  initWhatsAppBot().catch((err) => console.error("[whatsapp] init failed:", err?.message || err));
});

// Upgrade HTTP requests on /api/secretary/live to WebSocket Server
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/api/secretary/live") {
    socket.destroy();
    return;
  }
  // The live socket proxies to Gemini on the server's key AND exposes PC/Google
  // tools via execTool — so it MUST be authenticated, same as every /api route.
  // WebSockets can't set an Authorization header, so the token rides the query.
  verifyToken(url.searchParams.get("token"))
    .then((user) => {
      if (!user || user === UNREACHABLE) {
        // UNREACHABLE is a truthy Symbol — without this check a Supabase outage
        // would wave every unverified socket straight through.
        socket.write(user === UNREACHABLE ? "HTTP/1.1 503 Service Unavailable\r\n\r\n" : "HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    })
    .catch(() => socket.destroy());
});

// On `node --watch` (and fast manual restarts) a fresh process can try to bind
// before the previous one has released the port. Instead of crashing the whole
// server, wait a beat and retry the bind so the restart self-heals.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[server] port ${port} still busy — retrying in 1s…`);
    setTimeout(() => server.listen(port), 1000);
  } else {
    throw err;
  }
});

// Graceful shutdown so Render/Railway deploys don't cut requests mid-flight.
// Critically, force-close any keep-alive HTTP
// sockets — otherwise server.close() blocks on them and the old process keeps
// holding port 3000, making every --watch restart collide with EADDRINUSE.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${sig} received, shutting down`);
  // Without this the Baileys socket keeps the process alive past server.close()
  // and its reconnect timer fires into a half-dead process on every --watch restart.
  closeWhatsAppBot().catch(() => {});
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => shutdown(sig));
