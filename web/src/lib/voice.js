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
  ayus: { prefer: ["en-IN", "hi-IN"], female: true, pitch: 1.05, rate: 1.0 },
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
export function createRecognizer({ onResult, onEnd, onError, continuous = false }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = "hi-IN";
  rec.interimResults = true;
  rec.continuous = continuous;
  rec.onresult = (e) => {
    const transcript = Array.from(e.results).map((r) => r[0].transcript).join("");
    const isFinal = e.results[e.results.length - 1].isFinal;
    onResult?.(transcript, isFinal);
  };
  rec.onend = () => onEnd?.();
  rec.onerror = (e) => onError?.(e.error);
  return rec;
}

// ---------- Server-side speech-to-text (Groq Whisper) ----------
// Records a single utterance with the MediaRecorder API and ships the audio to
// /api/stt for transcription. Works in every modern browser (Chrome, Edge,
// Firefox, Safari) — unlike the Chromium-only Web Speech API above, which we
// now only use for the ambient "Hello AYUS" wake word.

function pickRecorderMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

// Temporary verbose logging to pinpoint where the voice flow stops.
const vlog = (...a) => console.log("%c[voice]", "color:#22d3ee", ...a);

// Whisper emits these stock phrases when handed silence or background noise —
// drop them so a quiet room, or the tail of AYUS's own TTS bleeding into the
// mic, never triggers a bogus turn.
const WHISPER_JUNK = new Set([
  "thank you", "thank you very much", "thanks", "thanks for watching",
  "thank you for watching", "please subscribe", "you", "bye", "okay", "ok",
  "uh", "um", "hej da", "thank", "so", ".",
]);
function isJunkTranscript(text) {
  const s = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, "")
    .replace(/\s+/g, " ");
  if (s.length <= 1) return true;
  return WHISPER_JUNK.has(s);
}

async function transcribeBlob(blob) {
  vlog("transcribe: posting", blob.size, "bytes", blob.type);
  const { data } = await getSupabase().auth.getSession();
  const token = data?.session?.access_token;
  if (!token) vlog("transcribe: WARNING no auth token — /api/stt will 401");
  const type = blob.type || "audio/webm";
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mp4" : "webm";
  const res = await fetch(`/api/stt?ext=${ext}`, {
    method: "POST",
    headers: { "Content-Type": type, Authorization: `Bearer ${token}` },
    body: blob,
  });
  vlog("transcribe: /api/stt responded", res.status);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    vlog("transcribe: error body", body.slice(0, 200));
    throw new Error(`STT ${res.status}`);
  }
  const json = await res.json();
  vlog("transcribe: text =", JSON.stringify(json.text));
  return String(json.text || "").trim();
}

/**
 * Start a hands-free listening turn: open the mic, record until the speaker
 * goes quiet (voice-activity detection), then transcribe via Groq Whisper.
 *
 * Callbacks:
 *  - onListening(): fired once the mic is actually live (permission granted)
 *  - onResult(text): fired with the transcript when speech was captured
 *  - onEnd(gotSpeech): fired when the turn ends (true if speech was heard)
 *  - onError(code): "not-allowed" | "mic-failed" | "transcribe-failed"
 *
 * Returns a controller: { stop() } finishes & transcribes now; { cancel() }
 * aborts the turn without transcribing (used for barge-in / closing the panel).
 */
export function createMicSession({
  onListening,
  onResult,
  onEnd,
  onError,
  onLevel, // (rms: number) → live input loudness, for a voice-reactive UI
  silenceMs = 1100,
  maxMs = 15000,
  speechThreshold = 0.013, // RMS above this counts as "speaking" (VAD silence detection)
  minPeakRms = 0.05, // a turn must peak at least this loud, else it's noise → skip transcription
}) {
  let stream = null;
  let audioCtx = null;
  let recorder = null;
  let chunks = [];
  let vadTimer = null;
  let silenceTimer = null;
  let hardTimer = null;
  let sawSpeech = false;
  let forceSend = false;
  let done = false;
  let cancelled = false;
  let peakRms = 0;

  function teardown() {
    clearInterval(vadTimer);
    clearTimeout(silenceTimer);
    clearTimeout(hardTimer);
    stream?.getTracks().forEach((t) => t.stop());
    audioCtx?.close().catch(() => {});
  }

  async function finish() {
    teardown();
    if (cancelled) return;
    const blob = chunks.length ? new Blob(chunks, { type: recorder?.mimeType || "audio/webm" }) : null;
    vlog("session: turn ended — sawSpeech:", sawSpeech, "peakRms:", peakRms.toFixed(3),
      "chunks:", chunks.length, "force:", forceSend);
    // Only transcribe when we actually captured speech: the VAD saw speech AND
    // the clip peaked loud enough to be a real voice (not silence/noise). A
    // manual stop (forceSend) transcribes whatever was captured.
    const heardSpeech = sawSpeech && peakRms >= minPeakRms;
    if (!blob || (!heardSpeech && !forceSend)) {
      onEnd?.(false);
      return;
    }
    try {
      const raw = await transcribeBlob(blob);
      const text = isJunkTranscript(raw) ? "" : raw;
      if (text) onResult?.(text);
      else vlog("session: dropped junk/empty transcript:", JSON.stringify(raw));
      onEnd?.(Boolean(text));
    } catch {
      onError?.("transcribe-failed");
      onEnd?.(false);
    }
  }

  function endTurn(force = false) {
    if (done) return;
    done = true;
    forceSend = force;
    if (recorder && recorder.state !== "inactive") recorder.stop(); // → onstop → finish()
    else finish();
  }

  async function start() {
    vlog("session: requesting mic…");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      vlog("session: getUserMedia FAILED", e?.name, e?.message);
      onError?.(e?.name === "NotAllowedError" ? "not-allowed" : "mic-failed");
      onEnd?.(false);
      return;
    }
    if (cancelled) {
      teardown();
      return;
    }
    vlog("session: mic live, recording");
    onListening?.();

    const mime = pickRecorderMime();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = finish;
    recorder.start();

    // Voice-activity detection: watch the input RMS. Once the speaker has said
    // something and then stays quiet for `silenceMs`, end the turn automatically.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // AudioContext often starts "suspended" until a gesture/resume — without
    // this the analyser reads pure silence and VAD never fires, so the turn
    // would hang forever and nothing is ever transcribed.
    if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    // setInterval (not requestAnimationFrame) so VAD keeps polling even if the
    // tab loses focus mid-utterance.
    vadTimer = setInterval(() => {
      if (done) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      peakRms = Math.max(peakRms, rms);
      onLevel?.(rms); // drive any voice-reactive visual (e.g. the AYUS reactor)
      if (rms > speechThreshold) {
        if (!sawSpeech) vlog("session: speech detected (rms", rms.toFixed(3) + ")");
        sawSpeech = true;
        clearTimeout(silenceTimer);
        silenceTimer = null;
      } else if (sawSpeech && !silenceTimer) {
        silenceTimer = setTimeout(() => {
          vlog("session: silence → ending turn");
          endTurn(false);
        }, silenceMs);
      }
    }, 60);
    hardTimer = setTimeout(() => endTurn(false), maxMs); // safety cap on a single turn
  }

  start();

  return {
    stop: () => endTurn(true), // manual stop → transcribe whatever was captured
    cancel() {
      cancelled = true;
      done = true;
      teardown();
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
    },
  };
}

export function voiceSupport() {
  const webSpeech = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const recorder = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  return {
    tts: Boolean(window.speechSynthesis),
    // Talk/dictation works in any browser via server-side Whisper (MediaRecorder).
    stt: recorder || webSpeech,
    // Always-on "Hello AYUS" wake word needs free local recognition → Chromium only.
    wake: webSpeech,
  };
}
