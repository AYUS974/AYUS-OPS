// Check: does the Live API accept our NON_BLOCKING declaration + toolResponse
// shape (id + name + response.scheduling) end to end?
// Run: node scripts/live-tool-roundtrip.js
import "dotenv/config";
import WebSocket from "ws";
import { CHAT_TOOL_DECLS } from "../src/lib/secretaryAgent.js";

const model = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;
const NON_BLOCKING_TOOLS = new Set(["delegate_to_researcher"]);

function upper(s) {
  if (!s || typeof s !== "object") return s;
  const o = { ...s };
  if (typeof o.type === "string") o.type = o.type.toUpperCase();
  if (o.properties) {
    const p = {};
    for (const [k, v] of Object.entries(o.properties)) p[k] = upper(v);
    o.properties = p;
  }
  if (o.items && typeof o.items === "object") o.items = upper(o.items);
  return o;
}

const functionDeclarations = CHAT_TOOL_DECLS.map((t) => {
  const d = { name: t.name, description: t.description };
  if (t.parameters?.properties && Object.keys(t.parameters.properties).length) d.parameters = upper(t.parameters);
  if (NON_BLOCKING_TOOLS.has(t.name)) d.behavior = "NON_BLOCKING";
  return d;
});

const ws = new WebSocket(url);
let called = false;

ws.on("open", () => ws.send(JSON.stringify({
  setup: {
    model,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: "You are AYUS. To research any topic you MUST call delegate_to_researcher." }] },
    tools: [{ functionDeclarations }],
    outputAudioTranscription: {},
  },
})));

ws.on("message", (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.setupComplete) {
    console.log("setup OK (NON_BLOCKING declared)");
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "Research the drone UTM market in India." }] }], turnComplete: true } }));
    return;
  }
  if (msg.toolCall) {
    const c = msg.toolCall.functionCalls[0];
    console.log(`toolCall: ${c.name}`);
    called = true;
    ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{
          id: c.id,
          name: c.name,
          response: { output: { ok: true, result: "Report: the Indian UTM market is early-stage." }, scheduling: "INTERRUPT" },
        }],
      },
    }));
    return;
  }
  if (msg.serverContent?.outputTranscription?.text) process.stdout.write(msg.serverContent.outputTranscription.text);
  if (msg.serverContent?.turnComplete && called) {
    console.log("\n\ntoolResponse accepted — model answered from it");
    process.exit(0);
  }
});

ws.on("close", (c, r) => { console.log(`\nCLOSED ${c} - ${r}`); process.exit(called ? 1 : 1); });
ws.on("error", (e) => { console.log(`ERR ${e.message}`); process.exit(1); });
setTimeout(() => { console.log("\nTIMEOUT"); process.exit(1); }, 45000);
