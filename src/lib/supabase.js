import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.warn(
    "[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. " +
      "Copy .env.example to .env and fill in your project keys."
  );
}

// Service-role client — this runs server-side only. Never ship this key to a browser.
export const db = createClient(url || "http://localhost:54321", key || "missing-key", {
  auth: { persistSession: false },
});
