import "./src/lib/ca.js";
import "dotenv/config";
import { glmJSON } from "./src/lib/glm.js";

async function main() {
  console.log("ZHIPU_API_KEY:", process.env.ZHIPU_API_KEY ? "SET" : "NOT SET");
  console.log("GLM_MODEL:", process.env.GLM_MODEL || "glm-4-flash");
  try {
    const res = await glmJSON({
      system: "You are a test assistant.",
      prompt: "Tell me a joke. Respond in JSON format.",
      schema: {
        type: "object",
        properties: {
          setup: { type: "string" },
          punchline: { type: "string" }
        },
        required: ["setup", "punchline"]
      }
    });
    console.log("Success response:", res);
  } catch (err) {
    console.error("Failed with error:", err.message || err);
  }
}
main();
