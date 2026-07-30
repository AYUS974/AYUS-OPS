// AYUS floating assistant (Electron overlay window).
//
// Same origin as the main app, so it shares the Supabase session and hits /api
// directly. Two listening modes:
//   live      — the Gemini Live socket from voice.js: hands-free, always on,
//               barge-in, sub-second replies. Used whenever the server has
//               GEMINI_LIVE_ENABLED, because the founder wants the pill to keep
//               listening while he works in other windows.
//   push      — fallback for when Live is off: record a turn, /api/stt, chat,
//               /api/tts. Press to talk.
import { initSupabase, getConfig, getAccessToken } from "./lib/api.js";
import { createGeminiLiveSession } from "./lib/voice.js";

const card = document.getElementById("card");
const log = document.getElementById("log");
const input = document.getElementById("input");
const chip = document.getElementById("chip");
const orb = document.getElementById("orb");
const stateEl = document.getElementById("state");
const micBtn = document.getElementById("micBtn");

// Resize the frameless window to hug the card (anchored to its bottom edge).
function fit() {
  requestAnimationFrame(() => {
    const h = Math.ceil(card.getBoundingClientRect().height) + 12; // 6px gutter x2
    window.ayus?.resize(h);
  });
}

function addLine(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

// Keep the transcript short — this is a pill, not a chat app.
function trimLog() {
  while (log.childElementCount > 40) log.removeChild(log.firstChild);
}

// --- state view -----------------------------------------------------------
const LABELS = {
  idle: "<b>AYUS</b>",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking… tap to stop",
};
let state = "idle";
function setState(s) {
  state = s;
  card.classList.remove("listening", "thinking", "speaking");
  if (s !== "idle") card.classList.add(s);
  stateEl.innerHTML = LABELS[s] || LABELS.idle;
  micBtn.classList.toggle("on", s === "listening");
  micBtn.classList.toggle("stop", s === "speaking");
  if (s !== "listening") orb.style.transform = "";
  fit();
}

const history = []; // {role, content} — text only; images ride one turn
let pendingImage = null; // a captured screen data URL awaiting the next send

// ---------------------------------------------------------------------------
// Live mode — hands-free, stays open while the founder uses other windows
// ---------------------------------------------------------------------------
let live = null; // active Gemini Live session
let userLine = null; // the live-updating "YOU" transcript line
let ayusLine = null; // the live-updating "AYUS" transcript line

// The socket dies for reasons that have nothing to do with intent: server
// restart, Wi-Fi blip, Gemini ending a long session. wantLive is the founder's
// actual intent and outlives all of them, so the pill re-dials itself instead
// of going quiet until someone notices and taps the mic.
let wantLive = false;
let reconnectTimer = 0;
let backoff = 800;

function scheduleReconnect() {
  if (!wantLive || reconnectTimer) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 15000); // give up on hammering a dead server
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (wantLive) startLive();
  }, wait);
}

function startLive() {
  if (live) return;
  wantLive = true;
  live = createGeminiLiveSession({
    onListening: () => {
      backoff = 800; // a healthy connection earns a fast retry next time
      setState("listening");
    },
    onLevel: (rms) => {
      if (state === "listening") orb.style.transform = `scale(${1 + Math.min(rms * 6, 1.1)})`;
    },
    onUserText: (text) => {
      if (!userLine) {
        ayusLine = null;
        userLine = addLine("you", "");
        trimLog();
      }
      userLine.textContent = text;
      log.scrollTop = log.scrollHeight;
    },
    onText: (text) => {
      if (!ayusLine) {
        userLine = null;
        ayusLine = addLine("ai", "");
        trimLog();
      }
      ayusLine.textContent = text;
      log.scrollTop = log.scrollHeight;
      setState("speaking");
      fit();
    },
    onEnd: () => {
      live = null;
      userLine = ayusLine = null;
      setState("idle");
      scheduleReconnect();
    },
    onError: (code) => {
      live = null;
      if (code === "mic-failed") {
        // Retrying can't fix a blocked mic — only the founder can.
        wantLive = false;
        addLine("ai err", "Microphone blocked — allow mic access, then tap the mic.");
      } else {
        scheduleReconnect();
      }
      setState("idle");
      fit();
    },
  });
}

function stopLive() {
  wantLive = false; // explicit stop — do not re-dial
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  if (!live) return setState("idle");
  try {
    live.stop();
  } catch {
    /* already gone */
  }
  live = null;
  userLine = ayusLine = null;
  setState("idle");
}

// Coming back from sleep/Wi-Fi loss doesn't always surface as a socket error —
// the browser just tells us the network is back. Re-dial immediately.
window.addEventListener("online", () => {
  if (wantLive && !live) {
    backoff = 800;
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    startLive();
  }
});

// ---------------------------------------------------------------------------
// Push-to-talk mode (Live disabled) — record, transcribe, chat, speak
// ---------------------------------------------------------------------------
let currentAudio = null;
async function speak(text) {
  const token = await getAccessToken();
  if (!token || !text) return;
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ text, agent: "ayus" }),
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    setState("speaking");
    await new Promise((resolve) => {
      currentAudio = new Audio(url);
      currentAudio.onended = currentAudio.onerror = () => {
        currentAudio = null;
        resolve();
      };
      currentAudio.play().catch(() => {
        currentAudio = null;
        resolve();
      });
    });
  } catch {
    /* stay silent — text is already on screen */
  } finally {
    if (state === "speaking") setState("idle");
  }
}
function stopSpeaking() {
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      /* nothing playing */
    }
    currentAudio = null;
  }
}

async function submit(text, viaVoice) {
  const image = pendingImage;
  if (!text && !image) return;
  pendingImage = null;
  chip.style.display = "none";

  const token = await getAccessToken();
  if (!token) {
    addLine("ai err", "Open the main AYUS window and sign in first, then try again.");
    setState("idle");
    return;
  }

  const userText = text || "What is on my screen right now? Help me with it.";
  addLine("you", image ? userText + "  📷" : userText);
  history.push({ role: "user", content: userText });
  if (history.length > 12) history.splice(0, history.length - 12);

  const pending = addLine("ai interim", "…");
  setState("thinking");

  try {
    const msgs = history.map((m, i) => (i === history.length - 1 && image ? { ...m, image } : m));
    const res = await fetch("/api/secretary/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ messages: msgs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || "request failed (" + res.status + ")");
    pending.className = "ai";
    pending.textContent = data.message || "(no reply)";
    history.push({ role: "assistant", content: data.message || "" });
    if (viaVoice) await speak(data.message);
    else setState("idle");
  } catch (e) {
    pending.className = "ai err";
    pending.textContent = "Error: " + e.message;
    setState("idle");
  }
  trimLog();
}

let stream = null,
  recorder = null,
  audioCtx = null,
  chunks = [],
  rafId = 0,
  maxTimer = 0;

function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return c.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

async function startListening() {
  stopSpeaking(); // barge-in: talking over AYUS cuts it off
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    addLine("ai err", "Microphone not available here.");
    fit();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    addLine("ai err", "Allow microphone access to talk to AYUS.");
    fit();
    return;
  }
  chunks = [];
  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = onRecordingStop;
  recorder.start();
  setState("listening");
  startVAD();
  maxTimer = setTimeout(() => stopListening(), 12000); // hard cap
}

// Voice-activity detection: wait for speech, then ~0.9s of silence → stop.
function startVAD() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return;
  }
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  let spoke = false,
    silentMs = 0,
    last = performance.now();
  (function tick() {
    if (state !== "listening") return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    orb.style.transform = "scale(" + (1 + Math.min(rms * 6, 1.1)) + ")";
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (rms > 0.045) {
      spoke = true;
      silentMs = 0;
    } else if (spoke) {
      silentMs += dt;
      if (silentMs > 900) {
        stopListening();
        return;
      }
    }
    rafId = requestAnimationFrame(tick);
  })();
}

function stopListening() {
  clearTimeout(maxTimer);
  cancelAnimationFrame(rafId);
  if (recorder && recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  }
}

async function onRecordingStop() {
  const tracks = stream ? stream.getTracks() : [];
  tracks.forEach((t) => t.stop());
  if (audioCtx) {
    try {
      audioCtx.close();
    } catch {
      /* already closed */
    }
    audioCtx = null;
  }
  stream = null;
  recorder = null;
  if (!chunks.length) {
    setState("idle");
    return;
  }
  const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
  setState("thinking");
  const token = await getAccessToken();
  const type = blob.type || "audio/webm";
  const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mp4" : "webm";
  try {
    const res = await fetch("/api/stt?ext=" + ext, {
      method: "POST",
      headers: { "Content-Type": type, Authorization: "Bearer " + token },
      body: blob,
    });
    const json = await res.json().catch(() => ({}));
    const text = String(json.text || "").trim();
    if (!res.ok || text.length <= 1) {
      setState("idle");
      return;
    }
    submit(text, true); // reply gets spoken
  } catch {
    addLine("ai err", "Didn't catch that — try again.");
    setState("idle");
  }
}

// --- mic button — one control, mode decides what it means -----------------
let liveMode = false;

micBtn.onclick = () => {
  if (liveMode) {
    if (live) stopLive();
    else startLive();
    return;
  }
  if (state === "listening") return stopListening(); // stop & send now
  if (state === "speaking") {
    stopSpeaking();
    setState("idle");
    return;
  }
  if (state === "thinking") return; // busy
  startListening();
};

// --- text send ------------------------------------------------------------
function send() {
  const t = input.value.trim();
  input.value = "";
  if (!t) return;
  // In live mode the typed turn goes down the same socket, so the answer comes
  // back spoken in AYUS's voice instead of as silent text.
  if (live) {
    addLine("you", t);
    userLine = ayusLine = null;
    live.sendText(t);
    setState("thinking");
    return;
  }
  submit(t, false);
}
document.getElementById("sendBtn").onclick = send;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    send();
  }
  if (e.key === "Escape") window.ayus?.hide();
});
document.getElementById("hideBtn").onclick = () => window.ayus?.hide();

// --- screen capture -------------------------------------------------------
// Manual "show AYUS my screen". AYUS can also grab the screen itself at any
// time via its screen_read tool, which runs server-side on this same machine.
const capBtn = document.getElementById("capBtn");
capBtn.onclick = async () => {
  if (!window.ayus) {
    addLine("ai err", "Screen capture is only available in the AYUS desktop app.");
    fit();
    return;
  }
  capBtn.disabled = true;
  try {
    pendingImage = await window.ayus.captureScreen();
    chip.style.display = "flex";
    input.focus();
    fit();
  } catch (e) {
    addLine("ai err", "Could not capture the screen: " + e.message);
    fit();
  } finally {
    capBtn.disabled = false;
  }
};
document.getElementById("chipX").onclick = () => {
  pendingImage = null;
  chip.style.display = "none";
  fit();
};

// --- boot -----------------------------------------------------------------
setState("idle");
fit();

initSupabase()
  .then(async () => {
    liveMode = Boolean(getConfig().geminiLiveEnabled);
    if (!(await getAccessToken())) {
      addLine("ai err", "Sign in on the main AYUS window, then reopen this pill.");
      fit();
      return;
    }
    // Hands-free by default: the pill floats over every other window, so it has
    // to keep listening while the founder works elsewhere.
    if (liveMode) startLive();
  })
  .catch((e) => {
    addLine("ai err", "Server unreachable: " + e.message);
    fit();
  });
