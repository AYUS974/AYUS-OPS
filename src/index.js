import "./lib/ca.js"; // trust Avast's MITM CA before any HTTPS call (must be first)
import "dotenv/config";
import express from "express";
import cron from "node-cron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { db } from "./lib/supabase.js";
import { executeAction } from "./lib/executor.js";
import { requireAuth } from "./lib/auth.js";
import { runAll } from "./orchestrator.js";
import { runSecretaryChat, runSecretaryChatGroq, runSecretaryChatStream } from "./lib/secretaryAgent.js";
import { learnFromDecision } from "./lib/memory.js";
import { dispatchHandoffs } from "./lib/handoffs.js";
import { notify, esc } from "./lib/notify.js";
import { buildAnalytics } from "./lib/analytics.js";
import { googleRouter, googleCallback, isGoogleConnected, listRecentEmails } from "./lib/google.js";
import { groqTranscribe } from "./lib/groq.js";

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
app.use(express.json({ limit: "100kb" }));

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
  });
});

// Google OAuth callback is public — Google redirects the browser here with no
// auth header. Registered before the authenticated /api router so it matches first.
app.get("/api/google/callback", googleCallback);

// ---------- Authenticated API ----------

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
    if (process.env.GROQ_API_KEY) {
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
    if (process.env.GROQ_API_KEY) {
      try {
        result = await runSecretaryChatStream(messages, {
          onDelta: (text) => sse({ type: "delta", text }),
          onToolEvent: (line) => sse({ type: "tool", line }),
        });
      } catch (groqErr) {
        // Groq throttled/failed mid-stream — fall back to Gemini (non-streaming),
        // emitting the whole answer as one delta so the client still gets it.
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
    else return res.status(404).json({ error: "no TTS provider configured" });

    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
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

// Google (Gmail + Calendar) connect/status/disconnect lives on its own router.
api.use("/google", googleRouter);

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
// click during the cron run) can't double-spend Claude calls.
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

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`AYUS Ops running → http://localhost:${port}`);
  console.log(`Agents scheduled: "${schedule}" (set DAILY_CRON in .env to change)`);
});

// Graceful shutdown so Render/Railway deploys don't cut requests mid-flight
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
