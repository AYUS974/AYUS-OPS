// Diagnostic: bisect which Live API setup field gets rejected.
// Run: node scripts/live-bisect.js [model]
import "dotenv/config";
import WebSocket from "ws";
import { CHAT_TOOL_DECLS, SYSTEM, companySnapshot } from "../src/lib/secretaryAgent.js";

const model = process.argv[2] || process.env.GEMINI_LIVE_MODEL || "models/gemini-2.0-flash-exp";
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const s = { ...schema };
  if (typeof s.type === "string") s.type = s.type.toUpperCase();
  if (s.properties) {
    const p = {};
    for (const [k, v] of Object.entries(s.properties)) p[k] = uppercaseSchemaTypes(v);
    s.properties = p;
  }
  if (s.items && typeof s.items === "object") s.items = uppercaseSchemaTypes(s.items);
  return s;
}

const rawTools = CHAT_TOOL_DECLS;
const tools = [{
  functionDeclarations: rawTools.map((t) => {
    const d = { name: t.name, description: t.description };
    if (t.parameters?.properties && Object.keys(t.parameters.properties).length) d.parameters = uppercaseSchemaTypes(t.parameters);
    return d;
  }),
}];

const realInstruction = `${SYSTEM}\n\n${await companySnapshot()}`;
console.log(`system instruction: ${realInstruction.length} chars`);

const base = { model, generationConfig: { responseModalities: ["AUDIO"] } };
const speech = { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } } };

const cases = {
  "1 minimal              ": { ...base },
  "2 +speechConfig        ": { ...base, generationConfig: { ...base.generationConfig, ...speech } },
  "3 +systemInstruction   ": { ...base, systemInstruction: { parts: [{ text: "You are a test." }] } },
  "4 +tools               ": { ...base, tools },
  "5 +outputTranscription ": { ...base, outputAudioTranscription: {} },
  "6 +inputTranscription  ": { ...base, inputAudioTranscription: {} },
  "7 all combined        ": {
    model,
    generationConfig: { responseModalities: ["AUDIO"], ...speech },
    systemInstruction: { parts: [{ text: "You are a test." }] },
    tools,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
  "8 exactly like server  ": {
    model,
    generationConfig: { responseModalities: ["AUDIO"], ...speech },
    systemInstruction: { parts: [{ text: realInstruction }] },
    tools,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  },
  "9 real instr only      ": { ...base, systemInstruction: { parts: [{ text: realInstruction }] } },
  "10 NON_BLOCKING tool   ": {
    ...base,
    tools: [{
      functionDeclarations: tools[0].functionDeclarations.map((d) =>
        d.name === "delegate_to_researcher" ? { ...d, behavior: "NON_BLOCKING" } : d
      ),
    }],
  },
};

function trial(name, setup) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      console.log(`${name} ${msg}`);
      try { ws.close(); } catch {}
      resolve();
    };
    ws.on("open", () => ws.send(JSON.stringify({ setup })));
    ws.on("message", (d) => { if (d.toString().includes("setupComplete")) finish("OK"); });
    ws.on("close", (c, r) => finish(`CLOSED ${c} - ${r}`));
    ws.on("error", (e) => finish(`ERR ${e.message}`));
    setTimeout(() => finish("TIMEOUT"), 10000);
  });
}

console.log(`model: ${model}\n`);
for (const [name, setup] of Object.entries(cases)) await trial(name, setup);
process.exit(0);
