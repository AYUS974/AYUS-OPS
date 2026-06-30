import "./src/lib/ca.js";
import "dotenv/config";
import WebSocket from "ws";
import {
  SYSTEM,
  GOOGLE_READ_TOOLS,
  REMEMBER_TOOL,
  PROPOSE_TOOL,
  SPOTIFY_TOOL,
  DELEGATE_RESEARCH_TOOL,
  execTool,
  companySnapshot,
} from "./src/lib/secretaryAgent.js";
import { PC_TOOL_DECLARATIONS } from "./src/lib/pc-tools.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not defined in .env!");
  process.exit(1);
}

function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const newSchema = { ...schema };
  if (typeof newSchema.type === "string") {
    newSchema.type = newSchema.type.toUpperCase();
  }
  if (newSchema.properties && typeof newSchema.properties === "object") {
    const newProps = {};
    for (const [key, val] of Object.entries(newSchema.properties)) {
      newProps[key] = uppercaseSchemaTypes(val);
    }
    newSchema.properties = newProps;
  }
  if (newSchema.items && typeof newSchema.items === "object") {
    newSchema.items = uppercaseSchemaTypes(newSchema.items);
  }
  return newSchema;
}

const rawTools = [...PC_TOOL_DECLARATIONS, ...GOOGLE_READ_TOOLS, SPOTIFY_TOOL, PROPOSE_TOOL, REMEMBER_TOOL, DELEGATE_RESEARCH_TOOL];
const formattedTools = [
  {
    functionDeclarations: rawTools.map(t => {
      const decl = {
        name: t.name,
        description: t.description,
      };
      if (t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length > 0) {
        decl.parameters = uppercaseSchemaTypes(t.parameters);
      }
      return decl;
    })
  }
];

const model = "models/gemini-2.0-flash-realtime-exp";
const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

console.log("Connecting to:", geminiUrl);
const ws = new WebSocket(geminiUrl);

ws.on("open", () => {
  console.log("Connected successfully! Sending setup message...");
  const setupMsg = {
    setup: {
      model,
      generationConfig: {
        responseModalities: ["AUDIO"],
      },
      tools: formattedTools
    }
  };
  ws.send(JSON.stringify(setupMsg));
});

ws.on("message", (data) => {
  console.log("Received message from Gemini:", data.toString());
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err);
});

ws.on("close", (code, reason) => {
  console.log(`Connection closed: Code ${code}, Reason: ${reason}`);
  process.exit(0);
});
