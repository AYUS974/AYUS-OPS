import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

/**
 * Free text-to-speech via Microsoft Edge's public TTS service.
 * No API key required — uses the same endpoint that Edge's Read Aloud feature
 * calls. Supports Hindi, English, and Hinglish (the voice handles code-switching
 * naturally). Each AYUS agent gets a distinct voice personality.
 *
 * Returns an MP3 Buffer so the caller can stream it to the client identically
 * to the paid Sarvam/Cartesia/ElevenLabs providers.
 */

// Per-agent voice mapping — hi-IN voices handle Hinglish beautifully.
// Override any of these via EDGE_VOICE_<AGENT> env vars.
const EDGE_VOICES = {
  ayus:      process.env.EDGE_VOICE_AYUS      || "hi-IN-SwaraNeural",      // composed female — JARVIS-style
  sales:     process.env.EDGE_VOICE_SALES     || "hi-IN-MadhurNeural",     // friendly male
  finance:   process.env.EDGE_VOICE_FINANCE   || "en-IN-NeerjaNeural",     // decisive female
  marketing: process.env.EDGE_VOICE_MARKETING || "hi-IN-MadhurNeural",     // warm male
  hr:        process.env.EDGE_VOICE_HR        || "hi-IN-SwaraNeural",      // friendly female
  cto:       process.env.EDGE_VOICE_CTO       || "en-IN-PrabhatNeural",    // deep, thoughtful male
};

// Rate/pitch tweaks per agent so they sound distinct even when sharing a base voice.
const EDGE_PROSODY = {
  ayus:      { rate: "+0%",  pitch: "+5%" },
  sales:     { rate: "+5%",  pitch: "+0%" },
  finance:   { rate: "-2%",  pitch: "-5%" },
  marketing: { rate: "+8%",  pitch: "+0%" },
  hr:        { rate: "+0%",  pitch: "+10%" },
  cto:       { rate: "-5%",  pitch: "-8%" },
};

/**
 * Generate speech audio from text using Edge TTS.
 *
 * @param {string} text  - The text to speak (max ~800 chars, pre-trimmed by caller)
 * @param {string} [agent="ayus"] - Which agent's voice to use
 * @returns {Promise<Buffer>} MP3 audio bytes
 */
export async function edgeTTS(text, agent = "ayus") {
  const voice = EDGE_VOICES[agent] || EDGE_VOICES.ayus;
  const prosody = EDGE_PROSODY[agent] || EDGE_PROSODY.ayus;

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  // msedge-tts v2's toStream() returns { audioStream, metadataStream } — NOT a
  // bare Readable. Iterating the wrapper object directly throws, so destructure
  // the audio stream first (this is what silently broke all Edge-TTS output).
  const { audioStream } = tts.toStream(text, {
    rate: prosody.rate,
    pitch: prosody.pitch,
  });

  // Collect the stream into a single Buffer
  const chunks = [];
  for await (const chunk of audioStream) {
    chunks.push(chunk);
  }
  const audio = Buffer.concat(chunks);

  if (!audio.length) throw new Error("Edge TTS returned empty audio");
  return audio;
}

/**
 * List available Edge TTS voices (useful for debugging / voice selection).
 * @returns {Promise<Array<{Name: string, ShortName: string, Locale: string, Gender: string}>>}
 */
export async function listEdgeVoices() {
  const tts = new MsEdgeTTS();
  return tts.getVoices();
}
