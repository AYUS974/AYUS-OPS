import "dotenv/config";
import { groqChat } from "./src/lib/groq.js";

async function main() {
  console.log("GROQ_API_KEY:", process.env.GROQ_API_KEY ? "SET" : "NOT SET");
  console.log("GROQ_MODEL:", process.env.GROQ_MODEL);
  try {
    const res = await groqChat([{ role: "user", content: "Hello AYUS" }], []);
    console.log("Success response:", res);
  } catch (err) {
    console.error("Failed with error:", err);
  }
}
main();
