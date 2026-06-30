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
    const { data } = await getSupabase().auth.getSession();
    const token = data?.session?.access_token;
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

  // Initialize playback AudioContext
  playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
  nextPlayTime = playbackCtx.currentTime;

  // 1. Establish WebSocket Connection to Backend
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/api/secretary/live`;
  
  console.log("[live-ws] Connecting to live session:", wsUrl);
  ws = new WebSocket(wsUrl);

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
      if (msg.serverContent) {
        // Handle User Turn transcription
        if (msg.serverContent.userTurn) {
          const parts = msg.serverContent.userTurn.parts || [];
          let userText = "";
          for (const part of parts) {
            if (part.text) userText += part.text;
          }
          if (userText) {
            onUserText?.(userText);
          }
        }

        // Handle Model Response
        if (msg.serverContent.modelTurn) {
          const parts = msg.serverContent.modelTurn.parts || [];
          for (const part of parts) {
            if (part.inlineData && part.inlineData.data) {
              playPCMChunk(part.inlineData.data);
            }
            if (part.text) {
              onText?.(part.text);
            }
          }
        }
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
