// Diagnostic: which realtimeInput audio shape does the Live API accept?
// Run: node scripts/live-audio-test.js [model]
import "dotenv/config";
import WebSocket from "ws";

const model = process.argv[2] || process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

// 100ms of silence @16kHz mono 16-bit
const pcm = Buffer.alloc(3200).toString("base64");

const shapes = {
  "audio blob            ": { realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm } } },
  "audio blob no rate    ": { realtimeInput: { audio: { mimeType: "audio/pcm", data: pcm } } },
  "mediaChunks (old)     ": { realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm }] } },
};

function trial(name, msg) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let done = false;
    const finish = (r) => { if (done) return; done = true; console.log(`${name} ${r}`); try { ws.close(); } catch {} resolve(); };
    ws.on("open", () => {
      ws.send(JSON.stringify({ setup: { model, generationConfig: { responseModalities: ["AUDIO"] } } }));
      // Server does not wait for setupComplete before forwarding mic audio — mimic that.
      if (process.argv.includes("--no-wait")) for (let i = 0; i < 5; i++) ws.send(JSON.stringify(msg));
    });
    ws.on("message", (d) => {
      const s = d.toString();
      if (s.includes("setupComplete")) {
        for (let i = 0; i < 5; i++) ws.send(JSON.stringify(msg));
        setTimeout(() => finish("ACCEPTED (no rejection in 5s)"), 5000);
      }
    });
    ws.on("close", (c, r) => finish(`CLOSED ${c} - ${r}`));
    ws.on("error", (e) => finish(`ERR ${e.message}`));
    setTimeout(() => finish("TIMEOUT"), 12000);
  });
}

console.log(`model: ${model}\n`);
for (const [name, msg] of Object.entries(shapes)) await trial(name, msg);
process.exit(0);
