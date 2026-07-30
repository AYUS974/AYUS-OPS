// Replay the setup message the running server actually sent (last-setup.json)
// against the Live API, to see which field it rejects.
// Run: node scripts/live-replay-setup.js
import "dotenv/config";
import fs from "node:fs";
import WebSocket from "ws";

const setupMsg = JSON.parse(fs.readFileSync(new URL("../last-setup.json", import.meta.url)));
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

const s = setupMsg.setup;
console.log(`model: ${s.model}`);
console.log(`top-level keys: ${Object.keys(s).join(", ")}`);
console.log(`generationConfig keys: ${Object.keys(s.generationConfig || {}).join(", ")}`);
console.log(`tools: ${(s.tools?.[0]?.functionDeclarations || []).length} declarations`);
console.log(`systemInstruction: ${(s.systemInstruction?.parts?.[0]?.text || "").length} chars\n`);

const ws = new WebSocket(url);
ws.on("open", () => ws.send(JSON.stringify(setupMsg)));
ws.on("message", (d) => { if (d.toString().includes("setupComplete")) { console.log("OK — setup accepted"); process.exit(0); } });
ws.on("close", (c, r) => { console.log(`CLOSED ${c} - ${r}`); process.exit(1); });
ws.on("error", (e) => { console.log(`ERR ${e.message}`); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 15000);
