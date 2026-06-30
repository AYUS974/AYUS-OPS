import "./src/lib/ca.js";
import "dotenv/config";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not defined in .env!");
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

async function run() {
  console.log("Fetching available models from Google AI Studio...");
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`HTTP Error: ${res.status} ${res.statusText}`);
      const text = await res.text();
      console.error(text);
      return;
    }
    const data = await res.json();
    const liveModels = (data.models || []).filter(m => 
      m.supportedGenerationMethods && 
      m.supportedGenerationMethods.some(method => method.includes("bidiGenerateContent"))
    );

    console.log("\n=== ALL MODELS SUPPORTED BY YOUR API KEY ===");
    for (const m of (data.models || [])) {
      console.log(`- ${m.name} (${m.displayName})`);
    }

    console.log("\n=== MODELS THAT SUPPORT LIVE API (bidiGenerateContent) ===");
    if (liveModels.length === 0) {
      console.log("None of the models returned support bidiGenerateContent for this API key!");
    } else {
      for (const m of liveModels) {
        console.log(`- ${m.name} (${m.displayName})`);
      }
    }
  } catch (err) {
    console.error("Failed to fetch models:", err);
  }
}

run();
