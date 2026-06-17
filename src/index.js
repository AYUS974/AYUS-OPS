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
import { runSecretaryChat } from "./lib/secretaryAgent.js";
import { learnFromDecision } from "./lib/memory.js";
import { dispatchHandoffs } from "./lib/handoffs.js";
import { notify, esc } from "./lib/notify.js";
import { buildAnalytics } from "./lib/analytics.js";
import { googleRouter, googleCallback } from "./lib/google.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    const { message, toolEvents, suggestedAction } = await runSecretaryChat(messages);
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

// Text-to-speech: Cartesia (primary) → ElevenLabs (fallback) → 404, in which
// case the browser falls back to its built-in speechSynthesis voices (free).
const CARTESIA_VOICES = {
  // Starter-library voices matched to each agent's personality; override in .env.
  ayus: process.env.CARTESIA_VOICE_AYUS || "5ee9feff-1265-424a-9d7f-8e4d431a12c7", // deep, composed — JARVIS-style
  sales: process.env.CARTESIA_VOICE_SALES || "630ed21c-2c5c-41cf-9d82-10a7fd668370", // Corey — cheerful
  finance: process.env.CARTESIA_VOICE_FINANCE || "62ae83ad-4f6a-430b-af41-a9bede9286ca", // Gemma — decisive
  marketing: process.env.CARTESIA_VOICE_MARKETING || "ef191366-f52f-447a-a398-ed8c0f2943a1", // Archie — warm
  hr: process.env.CARTESIA_VOICE_HR || "f786b574-daa5-4673-aa0c-cbe3e8534c02", // Katie — friendly
  cto: process.env.CARTESIA_VOICE_CTO || "5ee9feff-1265-424a-9d7f-8e4d431a12c7", // Ronald — deep thinker
};

const ELEVEN_VOICES = {
  ayus: process.env.ELEVENLABS_VOICE_AYUS || "pNInz6obpgDQGcFmaJgB", // Adam — deep male, JARVIS-style
  sales: process.env.ELEVENLABS_VOICE_SALES || "TxGEqnHWrfWFTfGW9XjX",
  finance: process.env.ELEVENLABS_VOICE_FINANCE || "EXAVITQu4vr4xnSDxMaL",
  marketing: process.env.ELEVENLABS_VOICE_MARKETING || "ErXwobaYiN019PkySvjV",
  hr: process.env.ELEVENLABS_VOICE_HR || "MF3mGyEYCl7XYWbV9V6O",
  cto: process.env.ELEVENLABS_VOICE_CTO || "VR6AewLTigWG4xSOukaG",
};

async function cartesiaTTS(text, agent) {
  const r = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.CARTESIA_API_KEY,
      "Cartesia-Version": "2024-11-13",
    },
    body: JSON.stringify({
      model_id: "sonic-2",
      transcript: text,
      voice: { mode: "id", id: CARTESIA_VOICES[agent] || CARTESIA_VOICES.ayus },
      output_format: { container: "mp3", bit_rate: 128000, sample_rate: 44100 },
      language: "en",
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
    if (process.env.CARTESIA_API_KEY) audio = await cartesiaTTS(clean, agent);
    else if (process.env.ELEVENLABS_API_KEY) audio = await elevenLabsTTS(clean, agent);
    else return res.status(404).json({ error: "no TTS provider configured" });

    res.set("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    // 502 → the browser voice fallback kicks in client-side
    res.status(502).json({ error: String(err.message || err) });
  }
});

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
