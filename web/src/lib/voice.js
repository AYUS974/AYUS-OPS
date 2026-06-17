// Voice engine: tries the server's /api/tts (ElevenLabs, if a key is set);
// otherwise falls back to the browser's built-in speechSynthesis — free,
// no key, works offline. Speech input uses the Web Speech API.
import { getSupabase } from "./api.js";

let voicesCache = [];
let currentAudio = null;
let speakingListeners = new Set();

function loadVoices() {
  voicesCache = window.speechSynthesis?.getVoices() || [];
}
if (typeof window !== "undefined" && window.speechSynthesis) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

// Per-agent voice personality. Hinglish text speaks best with hi-IN / en-IN
// voices; pitch/rate offsets keep agents distinct even with one base voice.
const AGENT_VOICE = {
  ayus: { prefer: ["en-GB", "en-IN"], female: false, pitch: 0.82, rate: 0.98 },
  sales: { prefer: ["en-IN", "hi-IN"], female: false, pitch: 1.0, rate: 1.05 },
  finance: { prefer: ["hi-IN", "en-IN"], female: true, pitch: 0.95, rate: 0.98 },
  marketing: { prefer: ["en-IN", "hi-IN"], female: false, pitch: 1.12, rate: 1.08 },
  hr: { prefer: ["hi-IN", "en-IN"], female: true, pitch: 1.15, rate: 1.0 },
  cto: { prefer: ["en-IN", "en-GB"], female: false, pitch: 0.88, rate: 0.97 },
};

const FEMALE_HINTS = /female|swara|heera|kalpana|priya|neerja|zira|aria|jenny|sonia/i;
const MALE_HINTS = /male|prabhat|madhur|hemant|ravi|david|guy|mark/i;

function pickVoice(agent) {
  const cfg = AGENT_VOICE[agent] || AGENT_VOICE.ayus;
  for (const lang of [...cfg.prefer, "en-US"]) {
    const inLang = voicesCache.filter((v) => v.lang?.toLowerCase().startsWith(lang.toLowerCase()));
    if (!inLang.length) continue;
    const gendered = inLang.find((v) =>
      cfg.female ? FEMALE_HINTS.test(v.name) : MALE_HINTS.test(v.name)
    );
    return gendered || inLang[0];
  }
  return voicesCache[0] || null;
}

// Strip markdown and emoji so TTS doesn't read "asterisk asterisk"
function cleanForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[*_#`>|]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function notifySpeaking(isSpeaking, agent) {
  for (const fn of speakingListeners) fn(isSpeaking, agent);
}

/** Subscribe to speaking state changes — returns an unsubscribe function. */
export function onSpeaking(fn) {
  speakingListeners.add(fn);
  return () => speakingListeners.delete(fn);
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  notifySpeaking(false, null);
}

/** Speak text in the given agent's voice. Resolves when speech ends. */
export async function speak(text, agent = "ayus") {
  const clean = cleanForSpeech(text);
  if (!clean) return;
  stopSpeaking();

  // Try server TTS first (only succeeds when ELEVENLABS_API_KEY is configured)
  try {
    const { data } = await getSupabase().auth.getSession();
    const token = data?.session?.access_token;
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: clean, agent }),
    });
    if (res.ok) {
      const blob = await res.blob();
      return await new Promise((resolve) => {
        currentAudio = new Audio(URL.createObjectURL(blob));
        notifySpeaking(true, agent);
        currentAudio.onended = currentAudio.onerror = () => {
          notifySpeaking(false, agent);
          resolve();
        };
        currentAudio.play().catch(() => {
          notifySpeaking(false, agent);
          resolve();
        });
      });
    }
  } catch {
    /* fall through to browser voices */
  }

  if (!window.speechSynthesis) return;
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clean);
    const cfg = AGENT_VOICE[agent] || AGENT_VOICE.ayus;
    const voice = pickVoice(agent);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.pitch = cfg.pitch;
    u.rate = cfg.rate;
    u.onstart = () => notifySpeaking(true, agent);
    u.onend = u.onerror = () => {
      notifySpeaking(false, agent);
      resolve();
    };
    window.speechSynthesis.speak(u);
  });
}

/**
 * Push-to-talk speech recognition (Hinglish: hi-IN understands mixed
 * Hindi-English well). Returns null if the browser doesn't support it.
 */
export function createRecognizer({ onResult, onEnd, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = "hi-IN";
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    const transcript = Array.from(e.results).map((r) => r[0].transcript).join("");
    const isFinal = e.results[e.results.length - 1].isFinal;
    onResult?.(transcript, isFinal);
  };
  rec.onend = () => onEnd?.();
  rec.onerror = (e) => onError?.(e.error);
  return rec;
}

export function voiceSupport() {
  return {
    tts: Boolean(window.speechSynthesis),
    stt: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
  };
}
