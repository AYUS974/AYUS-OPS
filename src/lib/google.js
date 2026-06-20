import express from "express";
import crypto from "node:crypto";
import { db } from "./supabase.js";

/**
 * Google integration — Gmail (read + send) and Calendar (read + create) for
 * the whole company. Implemented with plain fetch against Google's REST APIs
 * so there's no heavy SDK to install.
 *
 * Flow: you click "Connect Google" → consent screen → Google redirects to the
 * public /api/google/callback → we store access+refresh tokens in oauth_tokens.
 * Tokens auto-refresh server-side. Reads are used freely by the agents/AYUS;
 * anything that SENDS or CREATES still goes through your approval queue.
 *
 * Setup (one time, free):
 *   1. console.cloud.google.com → new project → APIs & Services
 *   2. Enable "Gmail API" and "Google Calendar API"
 *   3. OAuth consent screen → External → add yourself as a test user
 *   4. Credentials → OAuth client ID → Web application
 *      Authorized redirect URI: http://localhost:3000/api/google/callback
 *   5. Put the client id/secret in .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)
 */

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

const clientId = () => process.env.GOOGLE_CLIENT_ID;
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = () =>
  process.env.GOOGLE_REDIRECT_URI ||
  `${process.env.APP_BASE_URL || "http://localhost:3000"}/api/google/callback`;

export function googleConfigured() {
  return Boolean(clientId() && clientSecret());
}

// In-memory CSRF state for the connect → callback round-trip (single user).
const pendingStates = new Set();

// ---------- token storage ----------

async function loadTokens() {
  const { data } = await db.from("oauth_tokens").select("*").eq("provider", "google").maybeSingle();
  return data || null;
}

async function saveTokens(tok, accountEmail) {
  const row = {
    provider: "google",
    account_email: accountEmail ?? undefined,
    access_token: tok.access_token,
    scope: tok.scope,
    token_type: tok.token_type,
    expiry: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Google only returns refresh_token on the first consent — keep the old one otherwise.
  if (tok.refresh_token) row.refresh_token = tok.refresh_token;
  await db.from("oauth_tokens").upsert(row, { onConflict: "provider" });
}

export async function isGoogleConnected() {
  if (!googleConfigured()) return false;
  const t = await loadTokens();
  return Boolean(t?.refresh_token || t?.access_token);
}

// Return a valid access token, refreshing if it's expired/near-expiry.
async function accessToken() {
  if (!googleConfigured()) throw new Error("Google not configured (set GOOGLE_CLIENT_ID/SECRET)");
  const t = await loadTokens();
  if (!t) throw new Error("Google not connected — click Connect Google in the dashboard");

  const fresh = t.expiry && new Date(t.expiry).getTime() - Date.now() > 60_000;
  if (fresh && t.access_token) return t.access_token;

  if (!t.refresh_token) throw new Error("Google session expired — reconnect Google");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Google token refresh failed: ${(await r.text()).slice(0, 160)}`);
  const tok = await r.json();
  await saveTokens(tok, t.account_email);
  return tok.access_token;
}

async function gfetch(url, opts = {}) {
  const token = await accessToken();
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Google API ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.status === 204 ? {} : r.json();
}

// ---------- Calendar ----------

export async function createCalendarEvent({ summary, description, start, end, attendees = [] }) {
  const startISO = start || new Date(Date.now() + 3600000).toISOString();
  const endISO = end || new Date(new Date(startISO).getTime() + 1800000).toISOString();
  return gfetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      summary: summary || "AYUS Ops event",
      description: description || "",
      start: { dateTime: startISO },
      end: { dateTime: endISO },
      attendees: attendees.filter(Boolean).map((email) => ({ email })),
    }),
  });
}

export async function listUpcomingEvents({ maxResults = 10 } = {}) {
  const now = new Date().toISOString();
  const data = await gfetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      new URLSearchParams({
        timeMin: now,
        maxResults: String(maxResults),
        singleEvents: "true",
        orderBy: "startTime",
      })
  );
  return (data.items || []).map((e) => ({
    summary: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || null,
  }));
}

// ---------- Gmail ----------

export async function listRecentEmails({ q = "", maxResults = 8 } = {}) {
  const list = await gfetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?` +
      new URLSearchParams({ maxResults: String(maxResults), q })
  );
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    const msg = await gfetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?` +
        new URLSearchParams({ format: "metadata" }) +
        `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
    );
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    out.push({
      id,
      from: h.from || "",
      subject: h.subject || "(no subject)",
      date: h.date || "",
      snippet: msg.snippet || "",
      unread: (msg.labelIds || []).includes("UNREAD"),
    });
  }
  return out;
}

export async function sendGmail({ to, subject, body, cc }) {
  if (!to) throw new Error("gmail send needs a recipient");
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject || "(no subject)"}`,
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "MIME-Version: 1.0",
    "",
    body || "",
  ].filter((l) => l !== null);
  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  return gfetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
}

// ---------- OAuth routes ----------

// Authenticated router: status / connect-url / disconnect.
export const googleRouter = express.Router();

googleRouter.get("/status", async (_req, res) => {
  try {
    const t = googleConfigured() ? await loadTokens() : null;
    res.json({
      configured: googleConfigured(),
      connected: Boolean(t?.refresh_token || t?.access_token),
      account: t?.account_email || null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

googleRouter.get("/connect", (_req, res) => {
  if (!googleConfigured()) {
    return res.status(400).json({ error: "Google not configured — set GOOGLE_CLIENT_ID/SECRET in .env" });
  }
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60_000).unref?.();
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
    });
  res.json({ url });
});

googleRouter.post("/disconnect", async (_req, res) => {
  await db.from("oauth_tokens").delete().eq("provider", "google");
  res.json({ ok: true });
});

// PUBLIC callback (Google redirects the browser here — no auth header present).
// Mount this directly on the app, before the authenticated /api router.
export async function googleCallback(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?google=error`);
  if (!code || !state || !pendingStates.has(state)) {
    return res.redirect(`/?google=badstate`);
  }
  pendingStates.delete(state);
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const tok = await r.json();

    // Fetch the account email for display
    let email = null;
    try {
      const u = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (u.ok) email = (await u.json()).email;
    } catch {}

    await saveTokens(tok, email);
    res.redirect(`/?google=connected`);
  } catch (err) {
    console.error(`[google] callback failed: ${String(err).slice(0, 200)}`);
    res.redirect(`/?google=error`);
  }
}
