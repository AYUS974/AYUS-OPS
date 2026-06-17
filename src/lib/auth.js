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
 * Express middleware: requires a valid Supabase Auth session token
 * (Authorization: Bearer <access_token>). Attaches the user to req.user.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "not signed in" });

  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "session invalid or expired" });
    req.user = data.user;
    next();
  } catch (err) {
    res.status(401).json({ error: `auth check failed: ${String(err.message || err)}` });
  }
}
