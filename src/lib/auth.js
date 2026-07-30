import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!anonKey) {
  console.warn(
    "[auth] SUPABASE_ANON_KEY not set — API auth will reject every request. " +
      "Find it next to your service role key in Supabase → Project Settings → API."
  );
}

// Anon-key client used only to validate user JWTs. The service-role client
// in supabase.js stays server-side for data access.
const authClient = createClient(url || "http://localhost:54321", anonKey || "missing-key", {
  auth: { persistSession: false },
});

/**
 * Returned instead of a user when Supabase itself couldn't be reached. The token
 * may be perfectly valid, so callers must answer 503 — a 401 tells the browser
 * its session died and kicks the founder out to the login screen over a Wi-Fi blip.
 */
export const UNREACHABLE = Symbol("supabase-unreachable");

// supabase-js swallows a failed fetch into `error` rather than throwing, so a
// dead network and a bad token arrive through the exact same channel. Real
// rejections carry an HTTP status (401/403); a connect timeout carries none.
function isNetworkFailure(error) {
  return Boolean(error) && (error.name === "AuthRetryableFetchError" || !error.status);
}

/**
 * Validate a Supabase access token. Returns the user, null if missing/invalid,
 * or UNREACHABLE if Supabase couldn't be reached at all.
 * Used by requireAuth and by the WebSocket upgrade (which can't set headers, so
 * the token rides in the query string instead).
 */
export async function verifyToken(token) {
  if (!token) return null;
  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user) {
      if (isNetworkFailure(error)) {
        console.warn(`[auth] Supabase unreachable (${error.message}) — session left intact`);
        return UNREACHABLE;
      }
      // Without this, an expired token and a wrong anon key look identical from
      // the browser: a bare 401.
      console.warn(`[auth] token rejected (${error?.status || "?"}): ${error?.message || "no user"}`);
      return null;
    }
    return data.user;
  } catch (err) {
    console.warn(`[auth] token check failed to reach Supabase: ${err.message}`);
    return UNREACHABLE;
  }
}

/**
 * Express middleware: requires a valid Supabase Auth session token
 * (Authorization: Bearer <access_token>). Attaches the user to req.user.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "not signed in" });
  const user = await verifyToken(token);
  if (user === UNREACHABLE) {
    return res.status(503).json({ error: "auth service unreachable — retry in a moment", retryable: true });
  }
  if (!user) return res.status(401).json({ error: "session invalid or expired" });
  req.user = user;
  next();
}
