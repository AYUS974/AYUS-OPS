// Voice engine: tries the server's /api/tts (ElevenLabs, if a key is set);
// otherwise falls back to the browser's built-in speechSynthesis — free,
// no key, works offline. Speech input uses the Web Speech API.
import { getAccessToken } from "./api.js";
import { startWakeListener, stopWakeListener } from "./wakeword.js";

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

// --- Barge-in listener: "say AYUS to interrupt" during TTS ----------------
// While AYUS is speaking, a background mic session listens for the user saying
// "AYUS [command]". Transcription goes through Groq Whisper (server-side). Only
// transcripts starting with "AYUS" (or common mis-hearings) are honoured — all
// other noise is silently discarded.
//
// This complements the Picovoice Porcupine listener (wakeword.js), which gives
// instant (~100ms) keyword detection when configured but can't capture the
// follow-up command. The barge-in listener captures the FULL utterance including
// the command after the wake word. Both run in parallel if available.

const BARGE_RE = /^(hello\s+|hey\s+|ok\s+|are\s+|hi\s+)?(ayus|ayush|आयुष|एयुस|एयूस)\b/i;
let bargeInStream = null;
let bargeInCtx = null;
let bargeInRecorder = null;
let bargeInActive = false;
let bargeInListeners = new Set(); // subscribers: fn(command: string | null)

/** Subscribe to barge-in events. Called with the command after "AYUS" (or null
 *  if the user just said "AYUS" with nothing after it). Returns unsubscribe. */
export function onBargeIn(fn) {
  bargeInListeners.add(fn);
  return () => bargeInListeners.delete(fn);
}

function notifyBargeIn(command) {
  for (const fn of bargeInListeners) fn(command);
}

// Transcribe a blob via the server's /api/stt (Groq Whisper).
async function bargeInTranscribe(blob) {
  try {
    const token = await getAccessToken();
    if (!token) return null;
    const type = blob.type || "audio/webm";
    const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mp4" : "webm";
    const res = await fetch(`/api/stt?ext=${ext}`, {
      method: "POST",
      headers: { "Content-Type": type, Authorization: `Bearer ${token}` },
      body: blob,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return String(json.text || "").trim();
  } catch {
    return null;
  }
}

function startBargeInListener() {
  if (bargeInActive) return;
  bargeInActive = true;
  console.log("%c[barge-in]", "color:#f59e0b", "starting listener during TTS");

  // We'll run a series of short recording segments (~2-3 seconds each) back to
  // back. Each segment is transcribed; if it starts with "AYUS" we act on it.
  // This loop runs until stopBargeInListener() sets bargeInActive = false.
  (async function loop() {
    try {
      bargeInStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.warn("[barge-in] mic access failed:", err?.message);
      bargeInActive = false;
      return;
    }

    bargeInCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (bargeInCtx.state === "suspended") await bargeInCtx.resume().catch(() => {});
    // Pull it back if the browser suspends on backgrounding.
    bargeInCtx.onstatechange = () => {
      if (bargeInCtx?.state === "suspended") bargeInCtx.resume().catch(() => {});
    };

    const source = bargeInCtx.createMediaStreamSource(bargeInStream);
    const processor = bargeInCtx.createScriptProcessor(2048, 1, 1);
    const sink = bargeInCtx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(bargeInCtx.destination);

    // State for the recording loop.
    const SPEECH_THRESHOLD = 0.015;
    const MIN_PEAK_RMS = 0.04;
    const SILENCE_SEC = 0.9;
    const MAX_SEG_SEC = 4;

    let sawSpeech = false;
    let peakRms = 0;
    let lastVoiceAt = bargeInCtx.currentTime;
    let segStartAt = bargeInCtx.currentTime;
    let chunks = [];

    const mime = (() => {
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      return candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
    })();

    bargeInRecorder = new MediaRecorder(bargeInStream, mime ? { mimeType: mime } : undefined);
    bargeInRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    // When a segment ends (stop() is called), transcribe and check for "AYUS".
    bargeInRecorder.onstop = async () => {
      const blob = chunks.length ? new Blob(chunks, { type: bargeInRecorder?.mimeType || "audio/webm" }) : null;
      const hadSpeech = sawSpeech && peakRms >= MIN_PEAK_RMS;

      // Reset for next segment.
      chunks = [];
      sawSpeech = false;
      peakRms = 0;
      segStartAt = bargeInCtx?.currentTime || 0;
      lastVoiceAt = segStartAt;

      if (blob && hadSpeech) {
        const text = await bargeInTranscribe(blob);
        if (text) {
          console.log("%c[barge-in]", "color:#f59e0b", "transcribed:", JSON.stringify(text));
          const match = text.match(BARGE_RE);
          if (match) {
            // Extract command after "AYUS" — e.g. "AYUS play some music" → "play some music"
            const idx = text.toLowerCase().lastIndexOf(match[2].toLowerCase());
            const command = text.slice(idx + match[2].length).replace(/^[\s,.!?]+/, "").trim();
            console.log("%c[barge-in]", "color:#f59e0b", "AYUS detected! command:", JSON.stringify(command || "(none)"));
            stopSpeaking(); // interrupt TTS
            notifyBargeIn(command || null);
            stopBargeInListener();
            return; // don't start next segment
          }
          // Not an AYUS command — discard silently.
          console.log("%c[barge-in]", "color:#f59e0b", "discarded (no AYUS prefix)");
        }
      }

      // Start next segment if still active.
      if (bargeInActive && bargeInRecorder && bargeInStream?.active) {
        try {
          bargeInRecorder.start();
        } catch {
          /* stream or recorder was torn down */
        }
      }
    };

    // VAD — runs on the audio thread via ScriptProcessor (not throttled in
    // background tabs). Ends each segment on silence or timeout.
    processor.onaudioprocess = (e) => {
      if (!bargeInActive || !bargeInRecorder || bargeInRecorder.state !== "recording") return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      peakRms = Math.max(peakRms, rms);

      const now = bargeInCtx.currentTime;
      if (rms > SPEECH_THRESHOLD) {
        sawSpeech = true;
        lastVoiceAt = now;
      } else if (sawSpeech && now - lastVoiceAt >= SILENCE_SEC) {
        // Silence after speech — end segment, transcribe.
        try { bargeInRecorder.stop(); } catch { /* already stopped */ }
        return;
      }
      if (now - segStartAt >= MAX_SEG_SEC) {
        // Safety cap — end segment even if still talking, so latency stays low.
        try { bargeInRecorder.stop(); } catch { /* already stopped */ }
      }
    };

    // Kick off the first segment.
    bargeInRecorder.start();
  })();
}

function stopBargeInListener() {
  if (!bargeInActive) return;
  bargeInActive = false;
  console.log("%c[barge-in]", "color:#f59e0b", "stopping listener");
  if (bargeInRecorder && bargeInRecorder.state !== "inactive") {
    try {
      bargeInRecorder.onstop = null; // suppress the transcription on teardown
      bargeInRecorder.stop();
    } catch { /* already stopped */ }
  }
  bargeInRecorder = null;
  bargeInStream?.getTracks().forEach((t) => t.stop());
  bargeInStream = null;
  bargeInCtx?.close().catch(() => {});
  bargeInCtx = null;
}

function notifySpeaking(isSpeaking, agent) {
  // Keyword barge-in: listen for "AYUS" only while AYUS is speaking, and cut the
  // speech off the instant it's heard (→ the usual re-arm opens the mic for your
  // reply). No-op unless Picovoice is configured. Not used by the Gemini Live
  // path, which plays PCM directly and has its own native barge-in.
  if (isSpeaking) {
    startWakeListener(() => stopSpeaking());
    startBargeInListener(); // Whisper-based "AYUS [command]" listener
  } else {
    stopWakeListener();
    stopBargeInListener();
  }
  for (const fn of speakingListeners) fn(isSpeaking, agent);
}

/** Subscribe to speaking state changes — returns an unsubscribe function. */
export function onSpeaking(fn) {
  speakingListeners.add(fn);
  return () => speakingListeners.delete(fn);
}

// --- TTS playback queue ---------------------------------------------------
// A single queue plays clips back-to-back so streamed sentences never overlap.
// Speaking state is bracketed by the caller (speak / speakStream*), not by each
// clip, so it stays steady across sentence gaps while a reply streams in.
let ttsQueue = [];
let ttsDraining = false;
let streamingTts = false; // a streamed reply is still arriving — keep the queue "open"
let ttsDoneResolvers = [];

function finalizeTts() {
  notifySpeaking(false, null);
  const resolvers = ttsDoneResolvers;
  ttsDoneResolvers = [];
  resolvers.forEach((r) => r());
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  ttsQueue = [];
  streamingTts = false;
  finalizeTts();
}

// Play ONE clip — server TTS (/api/tts) if available, else the browser's own
// voice. Resolves when the clip ends. Does not touch speaking-state itself.
async function playClip(clean, agent) {
  try {
    const token = await getAccessToken();
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: clean, agent }),
    });
    if (res.ok) {
      const blob = await res.blob();
      await new Promise((resolve) => {
        currentAudio = new Audio(URL.createObjectURL(blob));
        currentAudio.onended = currentAudio.onerror = () => {
          currentAudio = null;
          resolve();
        };
        currentAudio.play().catch(() => {
          currentAudio = null;
          resolve();
        });
      });
      return;
    }
  } catch {
    /* fall through to browser voices */
  }

  if (!window.speechSynthesis) return;
  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(clean);
    const cfg = AGENT_VOICE[agent] || AGENT_VOICE.ayus;
    const voice = pickVoice(agent);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.pitch = cfg.pitch;
    u.rate = cfg.rate;
    u.onend = u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

async function drainTts() {
  if (ttsDraining) return;
  ttsDraining = true;
  try {
    while (ttsQueue.length) {
      const { clean, agent } = ttsQueue.shift();
      await playClip(clean, agent);
    }
  } finally {
    ttsDraining = false;
    // Done for now — but if a stream is still feeding sentences, stay "speaking".
    if (!streamingTts && ttsQueue.length === 0) finalizeTts();
  }
}

/** Speak text in the given agent's voice. Resolves when speech ends. */
export async function speak(text, agent = "ayus") {
  const clean = cleanForSpeech(text);
  if (!clean) return;
  stopSpeaking();
  notifySpeaking(true, agent);
  await playClip(clean, agent);
  notifySpeaking(false, null);
}

// --- Streaming TTS: speak a reply sentence-by-sentence as it generates -------
// Bracket a streamed reply with begin()/end(); feed completed sentences to
// chunk(). Speaking stays true the whole time (even between sentences), and
// whenTtsDone() resolves once the last sentence has finished playing.
export function speakStreamBegin(agent = "ayus") {
  stopSpeaking();
  streamingTts = true;
  notifySpeaking(true, agent);
}
export function speakStreamChunk(text, agent = "ayus") {
  const clean = cleanForSpeech(text);
  if (!clean) return;
  ttsQueue.push({ clean, agent });
  drainTts();
}
export function speakStreamEnd() {
  streamingTts = false;
  if (!ttsDraining && ttsQueue.length === 0) finalizeTts();
}
export function whenTtsDone() {
  if (!ttsDraining && ttsQueue.length === 0 && !streamingTts) return Promise.resolve();
  return new Promise((resolve) => ttsDoneResolvers.push(resolve));
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
  const token = await getAccessToken();
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
  let vadNode = null; // ScriptProcessor running VAD on the audio thread
  let sawSpeech = false;
  let forceSend = false;
  let done = false;
  let cancelled = false;
  let peakRms = 0;

  function teardown() {
    if (vadNode) {
      vadNode.onaudioprocess = null;
      try {
        vadNode.disconnect();
      } catch {
        /* already disconnected */
      }
      vadNode = null;
    }
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

    // Voice-activity detection runs on the AUDIO thread via a ScriptProcessor —
    // NOT a setInterval. Browsers throttle JS timers in background/unfocused
    // tabs, which used to kill listening the instant another app (Spotify, an
    // overlay) took the foreground. The audio callback keeps firing regardless
    // of focus, and we time silence/timeout off the audio clock (also unthrottled).
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
    // If the browser suspends the context on backgrounding, pull it back so VAD
    // keeps running while an active mic stream is feeding it.
    audioCtx.onstatechange = () => {
      if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
    };

    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(2048, 1, 1);
    const sink = audioCtx.createGain();
    sink.gain.value = 0; // silent: the node only needs to pull audio, not be heard
    source.connect(processor);
    processor.connect(sink);
    sink.connect(audioCtx.destination);
    vadNode = processor;

    const startedAt = audioCtx.currentTime;
    let lastVoiceAt = startedAt;
    const silenceSec = silenceMs / 1000;
    const maxSec = maxMs / 1000;

    processor.onaudioprocess = (e) => {
      if (done) return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      peakRms = Math.max(peakRms, rms);
      onLevel?.(rms); // drive any voice-reactive visual (e.g. the AYUS reactor)

      const now = audioCtx.currentTime;
      if (rms > speechThreshold) {
        if (!sawSpeech) vlog("session: speech detected (rms", rms.toFixed(3) + ")");
        sawSpeech = true;
        lastVoiceAt = now;
      } else if (sawSpeech && now - lastVoiceAt >= silenceSec) {
        vlog("session: silence → ending turn");
        endTurn(false);
        return;
      }
      if (now - startedAt >= maxSec) endTurn(false); // safety cap on a single turn
    };
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

export function createGeminiLiveSession({
  onListening,
  onLevel,
  onUserText,
  onText,
  onEnd,
  onError,
}) {
  let ws = null;
  let micStream = null;
  let micCtx = null;
  let processorNode = null;
  let playbackCtx = null;
  let nextPlayTime = 0;
  let active = true;
  let activeSources = []; // scheduled playback nodes, so barge-in can stop them
  let userTurnText = ""; // accumulates streamed input/output transcripts per turn
  let modelTurnText = "";

  // Initialize playback AudioContext
  playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
  nextPlayTime = playbackCtx.currentTime;

  // 1. Establish WebSocket Connection to Backend. The live socket is authed via
  // a Supabase token in the query string (WebSockets can't send headers).
  connect();

  async function connect() {
    let token = "";
    try {
      token = (await getAccessToken()) || "";
    } catch {
      /* no session — server will reject with 401 */
    }
    if (!active) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/secretary/live?token=${encodeURIComponent(token)}`;
    console.log("[live-ws] Connecting to live session");
    ws = new WebSocket(wsUrl);
    wireSocket();
  }

  function wireSocket() {

  ws.onopen = async () => {
    console.log("[live-ws] Connection established. Initializing mic...");
    onListening?.();
    
    try {
      // 2. Access Mic
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      
      if (!active) {
        teardown();
        return;
      }

      // 3. Setup Mic Audio Processing (16kHz mono PCM)
      micCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = micCtx.createMediaStreamSource(micStream);
      processorNode = micCtx.createScriptProcessor(2048, 1, 1);
      
      const sampleRate = micCtx.sampleRate;
      
      processorNode.onaudioprocess = (e) => {
        if (!active || ws.readyState !== WebSocket.OPEN) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Level/RMS detection
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        onLevel?.(rms);

        // Downsample to 16kHz
        const downsampled = downsampleBuffer(inputData, sampleRate, 16000);
        const pcm16 = floatTo16BitPCM(downsampled);
        
        ws.send(pcm16.buffer);
      };
      
      const silenceGain = micCtx.createGain();
      silenceGain.gain.value = 0;
      source.connect(processorNode);
      processorNode.connect(silenceGain);
      silenceGain.connect(micCtx.destination);
      
    } catch (err) {
      console.error("[live-ws] Mic initialization failed:", err);
      onError?.("mic-failed");
      ws.close();
    }
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const sc = msg.serverContent;
      if (!sc) return;

      // Barge-in: Gemini's own VAD flags when the user talks over AYUS. Stop the
      // queued audio immediately so AYUS goes quiet the instant you cut in.
      if (sc.interrupted) {
        flushPlayback();
        modelTurnText = "";
      }

      // Live captions. Gemini streams both transcripts token-by-token (enabled by
      // input/outputAudioTranscription in the server setup), so accumulate per turn.
      if (sc.inputTranscription?.text) {
        userTurnText += sc.inputTranscription.text;
        onUserText?.(userTurnText);
      }
      if (sc.outputTranscription?.text) {
        modelTurnText += sc.outputTranscription.text;
        onText?.(modelTurnText);
      }

      // Model audio (AUDIO modality) — and rare inline text.
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data) playPCMChunk(part.inlineData.data);
        if (part.text) {
          modelTurnText += part.text;
          onText?.(modelTurnText);
        }
      }

      // Turn done → reset transcript buffers for the next exchange.
      if (sc.turnComplete) {
        userTurnText = "";
        modelTurnText = "";
      }
    } catch (err) {
      console.error("[live-ws] Error handling incoming WS message:", err);
    }
  };

  ws.onerror = (err) => {
    console.error("[live-ws] WebSocket error:", err);
    onError?.("websocket-failed");
  };

  ws.onclose = () => {
    console.log("[live-ws] Connection closed");
    teardown();
    onEnd?.();
  };
  } // end wireSocket

  function playPCMChunk(base64Data) {
    if (!playbackCtx) return;
    if (playbackCtx.state === "suspended") {
      playbackCtx.resume().catch(() => {});
    }

    try {
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }

      const audioBuffer = playbackCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = playbackCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(playbackCtx.destination);
      // Track scheduled nodes so barge-in can stop them; drop each when it ends.
      activeSources.push(source);
      source.onended = () => {
        activeSources = activeSources.filter((s) => s !== source);
      };

      const now = playbackCtx.currentTime;
      if (nextPlayTime < now) {
        nextPlayTime = now + 0.03;
      }
      source.start(nextPlayTime);
      nextPlayTime += audioBuffer.duration;
    } catch (err) {
      console.error("[live-ws] Error playing audio chunk:", err);
    }
  }

  // Stop and drop every queued playback node — used on barge-in so AYUS's voice
  // cuts out the instant the user speaks over it.
  function flushPlayback() {
    for (const s of activeSources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSources = [];
    if (playbackCtx) nextPlayTime = playbackCtx.currentTime;
  }

  function teardown() {
    active = false;
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
    if (processorNode) {
      try {
        processorNode.disconnect();
      } catch {}
      processorNode = null;
    }
    if (micCtx) {
      micCtx.close().catch(() => {});
      micCtx = null;
    }
    if (playbackCtx) {
      playbackCtx.close().catch(() => {});
      playbackCtx = null;
    }
  }

  function downsampleBuffer(buffer, sampleRate, outSampleRate = 16000) {
    if (outSampleRate === sampleRate) return buffer;
    const sampleRateRatio = sampleRate / outSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = accum / count;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function floatTo16BitPCM(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
  }

  return {
    sendText(text) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const textMsg = {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [{ text }]
              }
            ],
            turnComplete: true
          }
        };
        ws.send(JSON.stringify(textMsg));
      }
    },
    stop() {
      if (ws) ws.close();
      teardown();
    },
    cancel() {
      if (ws) ws.close();
      teardown();
    }
  };
}
