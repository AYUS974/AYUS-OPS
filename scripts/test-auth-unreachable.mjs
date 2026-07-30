// A Supabase outage must NOT read as "your session expired".
// Run: node scripts/test-auth-unreachable.mjs
import assert from "node:assert/strict";
import "dotenv/config";

const realUrl = process.env.SUPABASE_URL;
const realKey = process.env.SUPABASE_ANON_KEY;

// auth.js reads the env at import time, so point it at a blackhole first.
process.env.SUPABASE_URL = "http://10.255.255.1:9";
process.env.SUPABASE_ANON_KEY = "anon-key-does-not-matter-here";
const { verifyToken, UNREACHABLE } = await import("../src/lib/auth.js");

assert.equal(await verifyToken(""), null, "missing token is not an outage");
assert.equal(
  await verifyToken("any.token.at.all"),
  UNREACHABLE,
  "unreachable Supabase must return UNREACHABLE (→ 503), not null (→ 401)"
);
console.log("ok: unreachable Supabase → UNREACHABLE");

// Other half: a reachable host must still reject a garbage token as invalid,
// or every dead session would get a 503 and never be told to sign in again.
if (realUrl && realKey) {
  process.env.SUPABASE_URL = realUrl;
  process.env.SUPABASE_ANON_KEY = realKey;
  const live = await import(`../src/lib/auth.js?live=${Date.now()}`); // fresh module = fresh env
  assert.equal(await live.verifyToken("garbage.token.value"), null, "a bad token must still be a 401");
  console.log("ok: reachable Supabase + bad token → null");
} else {
  console.log("skip: no SUPABASE_URL/ANON_KEY in env for the reachable half");
}
