// --- TLS trust shim (must be imported before any HTTPS call) ---
// This dev machine runs Avast antivirus, which MITMs HTTPS with its own root
// CA. Node doesn't trust that cert by default, so every outbound fetch (Groq,
// Sarvam, Supabase…) fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
//
// The fix is NODE_EXTRA_CA_CERTS, but Node reads it only at startup — setting
// process.env later is too late. So if it's missing and the exported Avast CA
// exists on disk, we re-exec this exact process once with the variable set
// (preserving node flags like --watch). No-ops when the cert isn't present, so
// CI and production (Render, etc.) are unaffected.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

if (!process.env.NODE_EXTRA_CA_CERTS) {
  const caPath = path.join(os.homedir(), ".avast-root-ca.pem");
  if (existsSync(caPath)) {
    console.log(`[ca] trusting Avast root CA → ${caPath}`);
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, ...process.argv.slice(1)],
      { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath } }
    );
    process.exit(result.status ?? 0);
  }
}
