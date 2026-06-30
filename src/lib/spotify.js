import express from "express";
import crypto from "node:crypto";
import { db } from "./supabase.js";

/**
 * Spotify integration — the ONLY reliable way to "play this exact song". The
 * desktop URI / media keys can't start a specific track (the Play key just
 * resumes whatever was last playing), so we use the Web API: search the track →
 * start playback on the founder's active device.
 *
 * Flow mirrors google.js: click "Connect Spotify" → consent → Spotify redirects
 * to the public /api/spotify/callback → tokens stored in oauth_tokens
 * (provider='spotify'), auto-refreshed server-side.
 *
 * Setup (one time, free): developer.spotify.com → Create app → copy Client
 * ID/Secret into .env (SPOTIFY_CLIENT_ID/SECRET) → in the app settings add the
 * redirect URI http://127.0.0.1:3000/api/spotify/callback. Playback control
 * requires a Spotify PREMIUM account (the API returns 403 on free).
 */

const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
];

const clientId = () => process.env.SPOTIFY_CLIENT_ID;
const clientSecret = () => process.env.SPOTIFY_CLIENT_SECRET;
const appBase = () => process.env.APP_BASE_URL || "http://127.0.0.1:3000";
const redirectUri = () =>
  process.env.SPOTIFY_REDIRECT_URI || `${appBase()}/api/spotify/callback`;

export function spotifyConfigured() {
  return Boolean(clientId() && clientSecret());
}

const basicAuth = () => "Basic " + Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64");

// In-memory CSRF state for the connect → callback round-trip (single user).
const pendingStates = new Set();

// ---------- token storage (shares the oauth_tokens table with Google) ----------

async function loadTokens() {
  const { data } = await db.from("oauth_tokens").select("*").eq("provider", "spotify").maybeSingle();
  return data || null;
}

async function saveTokens(tok, displayName) {
  const row = {
    provider: "spotify",
    account_email: displayName ?? undefined, // reuse the column to show the Spotify name
    access_token: tok.access_token,
    scope: tok.scope,
    token_type: tok.token_type,
    expiry: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Spotify only returns refresh_token on the first consent — keep the old one.
  if (tok.refresh_token) row.refresh_token = tok.refresh_token;
  await db.from("oauth_tokens").upsert(row, { onConflict: "provider" });
}

export async function isSpotifyConnected() {
  if (!spotifyConfigured()) return false;
  const t = await loadTokens();
  return Boolean(t?.refresh_token || t?.access_token);
}

async function accessToken() {
  if (!spotifyConfigured()) throw new Error("Spotify not configured (set SPOTIFY_CLIENT_ID/SECRET)");
  const t = await loadTokens();
  if (!t) throw new Error("Spotify not connected — click Connect Spotify in the dashboard");

  const fresh = t.expiry && new Date(t.expiry).getTime() - Date.now() > 60_000;
  if (fresh && t.access_token) return t.access_token;

  if (!t.refresh_token) throw new Error("Spotify session expired — reconnect Spotify");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  if (!r.ok) throw new Error(`Spotify token refresh failed: ${(await r.text()).slice(0, 160)}`);
  const tok = await r.json();
  await saveTokens(tok, t.account_email);
  return tok.access_token;
}

async function sfetch(url, opts = {}) {
  const token = await accessToken();
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (r.status === 204) return {};
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`Spotify API ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---------- search + playback ----------

export async function searchTrack(query) {
  const data = await sfetch(
    "https://api.spotify.com/v1/search?" + new URLSearchParams({ q: query, type: "track", limit: "1" })
  );
  const item = data.tracks?.items?.[0];
  if (!item) return null;
  return { uri: item.uri, name: item.name, artist: (item.artists || []).map((a) => a.name).join(", ") };
}

export async function listDevices() {
  const data = await sfetch("https://api.spotify.com/v1/me/player/devices");
  return data.devices || [];
}

/**
 * Play a specific track by search query on the active (or best available)
 * device. Returns { ok, result } or { ok:false, error, code } — code is
 * 'no_device' (open Spotify first) or 'premium_required'.
 */
export async function playTrack(query) {
  const track = await searchTrack(query);
  if (!track) return { ok: false, error: `No track found for "${query}".` };

  const devices = await listDevices();
  const device = devices.find((d) => d.is_active) || devices.find((d) => d.type === "Computer") || devices[0];
  if (!device) return { ok: false, error: "Open Spotify first so it shows as a device.", code: "no_device" };

  try {
    await sfetch("https://api.spotify.com/v1/me/player/play?" + new URLSearchParams({ device_id: device.id }), {
      method: "PUT",
      body: JSON.stringify({ uris: [track.uri] }),
    });
    return { ok: true, result: `Now playing "${track.name}" by ${track.artist} on Spotify.` };
  } catch (err) {
    if (err.status === 403) {
      return { ok: false, error: "Spotify playback control needs a Premium account.", code: "premium_required" };
    }
    if (err.status === 404) return { ok: false, error: "No active Spotify device — open Spotify and try again.", code: "no_device" };
    return { ok: false, error: String(err.message || err) };
  }
}

// Simple transport controls (Premium). action: pause | next | previous
export async function playback(action) {
  const map = { pause: ["PUT", "pause"], next: ["POST", "next"], previous: ["POST", "previous"], resume: ["PUT", "play"] };
  const m = map[action];
  if (!m) return { ok: false, error: `unknown action ${action}` };
  try {
    await sfetch(`https://api.spotify.com/v1/me/player/${m[1]}`, { method: m[0] });
    return { ok: true, result: `Spotify: ${action}` };
  } catch (err) {
    if (err.status === 403) return { ok: false, error: "Needs Spotify Premium.", code: "premium_required" };
    return { ok: false, error: String(err.message || err) };
  }
}

// ---------- OAuth routes ----------

export const spotifyRouter = express.Router();

spotifyRouter.get("/status", async (_req, res) => {
  try {
    const t = spotifyConfigured() ? await loadTokens() : null;
    res.json({
      configured: spotifyConfigured(),
      connected: Boolean(t?.refresh_token || t?.access_token),
      account: t?.account_email || null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

spotifyRouter.get("/connect", (_req, res) => {
  if (!spotifyConfigured()) {
    return res.status(400).json({ error: "Spotify not configured — set SPOTIFY_CLIENT_ID/SECRET in .env" });
  }
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60_000).unref?.();
  const url =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      client_id: clientId(),
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: SCOPES.join(" "),
      state,
    });
  res.json({ url });
});

spotifyRouter.post("/disconnect", async (_req, res) => {
  await db.from("oauth_tokens").delete().eq("provider", "spotify");
  res.json({ ok: true });
});

// PUBLIC callback (Spotify redirects the browser here — no auth header present).
export async function spotifyCallback(req, res) {
  const { code, state, error } = req.query;
  // Spotify forces the redirect_uri host to 127.0.0.1 (it rejects "localhost"),
  // so the browser lands here on 127.0.0.1. Redirect back to the canonical app
  // origin (APP_BASE_URL) so the user keeps the same origin — and therefore the
  // same Supabase session — they started with, instead of being silently
  // "logged out" on a mismatched host.
  if (error) return res.redirect(`${appBase()}/?spotify=error`);
  if (!code || !state || !pendingStates.has(state)) return res.redirect(`${appBase()}/?spotify=badstate`);
  pendingStates.delete(state);
  try {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: redirectUri(),
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const tok = await r.json();

    // Fetch the profile name (and Premium status) for display.
    let name = null;
    try {
      const u = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (u.ok) {
        const me = await u.json();
        name = me.display_name || me.id;
        if (me.product && me.product !== "premium") name += " (free — playback needs Premium)";
      }
    } catch {
      /* profile fetch is best-effort */
    }

    await saveTokens(tok, name);
    res.redirect(`${appBase()}/?spotify=connected`);
  } catch (err) {
    console.error(`[spotify] callback failed: ${String(err).slice(0, 200)}`);
    res.redirect(`${appBase()}/?spotify=error`);
  }
}
