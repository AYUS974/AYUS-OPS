import "dotenv/config";
import fs from "fs";
import { groqTranscribe } from "./src/lib/groq.js";

async function main() {
  try {
    const audioBytes = fs.readFileSync("ayus-voice-test.mp3");
    console.log("Audio size:", audioBytes.length, "bytes");
    const text = await groqTranscribe(audioBytes, { filename: "ayus-voice-test.mp3" });
    console.log("Transcription result:");
    console.log(text);
  } catch (error) {
    console.error("Error transcribing:", error);
  }
}
main();
