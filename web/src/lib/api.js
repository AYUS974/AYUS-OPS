import { createClient } from "@supabase/supabase-js";

let supabase = null;
let config = {};

/**
 * The server hands the frontend its Supabase URL + anon key at runtime
 * (/api/config), so the React build needs no environment variables.
 */
export async function initSupabase() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("could not reach the server");
  const data = await res.json();
  const { supabaseUrl, supabaseAnonKey } = data;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Server is missing SUPABASE_URL / SUPABASE_ANON_KEY in its .env");
  }
  config = data;
  supabase = createClient(supabaseUrl, supabaseAnonKey);
  return supabase;
}

export function getConfig() {
  return config;
}

export function getSupabase() {
  if (!supabase) throw new Error("supabase not initialised yet");
  return supabase;
}

/**
 * The access token to send on API calls. supabase-js auto-refreshes on a timer,
 * but browsers throttle timers in background tabs — so a cached session can hand
 * back a token that is already dead, and every route 401s until the tab is
 * reloaded. Refresh anything inside its last minute instead of trusting the cache.
 */
export async function getAccessToken() {
  const session = (await getSupabase().auth.getSession()).data?.session;
  if (!session) return null;
  if (session.expires_at * 1000 - Date.now() > 60_000) return session.access_token;
  const { data, error } = await getSupabase().auth.refreshSession();
  if (error) console.warn("[auth] token refresh failed:", error.message);
  return data?.session?.access_token || session.access_token;
}

/** Authenticated fetch against the ops API. */
export async function api(path, options = {}) {
  const token = await getAccessToken();

  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

/**
 * Stream a chat reply from /api/secretary/chat/stream (Server-Sent Events).
 * Calls onDelta(textChunk) as tokens arrive and onTool(line) on tool use;
 * resolves to the final { message, toolEvents, hasSuggestion, suggestedAction }.
 */
export async function streamSecretaryChat(messages, { onDelta, onTool } = {}) {
  const token = await getAccessToken();

  const res = await fetch("/api/secretary/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = null;

  // SSE frames are separated by a blank line; each carries one `data:` JSON line.
  for (;;) {
    const { value, done: streamEnded } = await reader.read();
    if (streamEnded) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let evt;
      try {
        evt = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (evt.type === "delta") onDelta?.(evt.text);
      else if (evt.type === "tool") onTool?.(evt.line);
      else if (evt.type === "done") done = evt;
      else if (evt.type === "error") throw new Error(evt.error);
    }
  }
  return done;
}

/**
 * Stream the inbox → leads scan from /api/inbox/scan/stream (Server-Sent Events).
 * Senders are qualified one at a time, most-recent-first; onEvent(evt) fires for
 * every step (start / skip-existing / not-lead / lead-added / error-item / done)
 * so the UI can drop a lead into the list the moment it lands, instead of
 * waiting for the entire inbox to be scanned. Resolves to the final "done" event.
 */
export async function streamInboxScan({ maxResults = 20 } = {}, { onEvent } = {}) {
  const token = await getAccessToken();

  const res = await fetch("/api/inbox/scan/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ maxResults }),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = null;

  for (;;) {
    const { value, done: streamEnded } = await reader.read();
    if (streamEnded) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let evt;
      try {
        evt = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (evt.type === "error") throw new Error(evt.error);
      if (evt.type === "done") done = evt;
      onEvent?.(evt);
    }
  }
  return done;
}
