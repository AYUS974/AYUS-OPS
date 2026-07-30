// Diagnostic: does a late setup message get rejected? Server awaits companySnapshot()
// after the socket opens, so setup can land seconds late.
// Run: node scripts/live-delay-test.js
import "dotenv/config";
import WebSocket from "ws";
import { companySnapshot } from "../src/lib/secretaryAgent.js";

const model = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

const t0 = Date.now();
await companySnapshot();
console.log(`companySnapshot() took ${Date.now() - t0}ms\n`);

function trial(delayMs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let done = false;
    const finish = (r) => { if (done) return; done = true; console.log(`setup after ${delayMs}ms: ${r}`); try { ws.close(); } catch {} resolve(); };
    ws.on("open", () => setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ setup: { model, generationConfig: { responseModalities: ["AUDIO"] } } }));
    }, delayMs));
    ws.on("message", (d) => { if (d.toString().includes("setupComplete")) finish("OK"); });
    ws.on("close", (c, r) => finish(`CLOSED ${c} - ${r}`));
    ws.on("error", (e) => finish(`ERR ${e.message}`));
    setTimeout(() => finish("TIMEOUT"), delayMs + 10000);
  });
}

for (const d of [0, 3000, 6000, 12000]) await trial(d);
process.exit(0);
