import "./src/lib/ca.js";
import "dotenv/config";

const MODEL = process.env.GLM_MODEL || "glm-4-7-flash";
const BASE_URL = process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
const URL = `${BASE_URL}/chat/completions`;

async function main() {
  const apiKey = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY;
  console.log("ZHIPU_API_KEY:", apiKey ? "SET" : "NOT SET");
  console.log("GLM_MODEL:", MODEL);

  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Check the weather in New York." }
  ];

  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a location.",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" }
          },
          required: ["location"]
        }
      }
    }
  ];

  const body = { 
    model: MODEL, 
    max_tokens: 1200, 
    temperature: 0.4, 
    messages, 
    stream: true
  };
  
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.tool_stream = true;
  }

  try {
    console.log("Fetching URL:", URL);
    console.log("Request Body:", JSON.stringify(body, null, 2));
    
    const res = await fetch(URL, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        Authorization: `Bearer ${apiKey}` 
      },
      body: JSON.stringify(body),
    });

    console.log("Response Status:", res.status);
    if (!res.ok) {
      const text = await res.text();
      console.error("Error Text:", text);
      return;
    }

    const decoder = new TextDecoder();
    console.log("Reading response body stream...");
    
    for await (const chunk of res.body) {
      const decoded = decoder.decode(chunk, { stream: true });
      console.log("=== CHUNK START ===");
      console.log(decoded);
      console.log("=== CHUNK END ===");
    }
    
    console.log("Stream finished reading.");
  } catch (err) {
    console.error("Fetch failed with error:", err);
  }
}
main();
