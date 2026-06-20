import { createClient } from "@supabase/supabase-js";

let supabase = null;

/**
 * The server hands the frontend its Supabase URL + anon key at runtime
 * (/api/config), so the React build needs no environment variables.
 */
export async function initSupabase() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("could not reach the server");
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Server is missing SUPABASE_URL / SUPABASE_ANON_KEY in its .env");
  }
  supabase = createClient(supabaseUrl, supabaseAnonKey);
  return supabase;
}

export function getSupabase() {
  if (!supabase) throw new Error("supabase not initialised yet");
  return supabase;
}

/** Authenticated fetch against the ops API. */
export async function api(path, options = {}) {
  const { data } = await getSupabase().auth.getSession();
  const token = data?.session?.access_token;

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
  const { data } = await getSupabase().auth.getSession();
  const token = data?.session?.access_token;

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
