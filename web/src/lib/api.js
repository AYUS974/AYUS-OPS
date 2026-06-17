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
