import "dotenv/config";
import { runSecretaryChatGroq } from "./src/lib/secretaryAgent.js";

async function main() {
  console.log("GROQ_API_KEY:", process.env.GROQ_API_KEY ? "SET" : "NOT SET");
  console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
  
  try {
    console.log("Calling runSecretaryChatGroq...");
    const res = await runSecretaryChatGroq([{ role: "user", content: "Hello AYUS" }]);
    console.log("Success:", res);
  } catch (err) {
    console.error("Caught error in chat run:", err);
  }
}

main();
