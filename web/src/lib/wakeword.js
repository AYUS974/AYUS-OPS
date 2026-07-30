// Porcupine keyword spotter — local, offline, WASM. Unlike the Web Speech API
// (dead in Electron), this runs anywhere, so it powers the "say AYUS to cut in"
// barge-in on the turn-based path and inside the desktop app.
//
// It listens ONLY while AYUS is speaking (see voice.js): during TTS the app's
// own mic is otherwise idle, so Porcupine gets the mic to itself — no dual-mic
// clash. On a keyword hit it fires onDetect, which stops the speech; the normal
// re-arm logic then opens the mic for your reply.
//
// Setup (all user-provided — the feature is a graceful no-op without them):
//   1. PICOVOICE_ACCESS_KEY in .env      (console.picovoice.ai, free tier)
//   2. web/public/porcupine_params.pv    (base English model, from Picovoice)
//   3. web/public/ayus.ppn  (optional)   (custom "AYUS" word, trained on the
//                                          Picovoice console; else "Jarvis")
import { getConfig } from "./api.js";

const MODEL_PATH = "/porcupine_params.pv";
const CUSTOM_KEYWORD_PATH = "/ayus.ppn"; // trained "AYUS"; optional

// Picovoice ships a large WASM blob — load it lazily (only when a key is set) so
// it never bloats the main bundle or loads for users who don't use the feature.
let deps = null;
async function loadDeps() {
  if (!deps) {
    const [pw, wvp] = await Promise.all([
      import("@picovoice/porcupine-web"),
      import("@picovoice/web-voice-processor"),
    ]);
    deps = { PorcupineWorker: pw.PorcupineWorker, BuiltInKeyword: pw.BuiltInKeyword, WebVoiceProcessor: wvp.WebVoiceProcessor };
  }
  return deps;
}

let worker = null;
let starting = null; // in-flight start() promise, so overlapping calls don't race
let active = false;
let onDetectCb = null;
let disabled = false; // init failed (missing key/model) — don't retry every turn

// Does a custom AYUS keyword file exist in public/? (HEAD, cached per session.)
let customKeywordPromise = null;
function hasCustomKeyword() {
  if (!customKeywordPromise) {
    customKeywordPromise = fetch(CUSTOM_KEYWORD_PATH, { method: "HEAD" })
      .then((r) => r.ok)
      .catch(() => false);
  }
  return customKeywordPromise;
}

async function build() {
  const accessKey = getConfig().picovoiceKey;
  if (!accessKey) {
    disabled = true;
    return null;
  }
  const { PorcupineWorker, BuiltInKeyword } = await loadDeps();
  const keyword = (await hasCustomKeyword())
    ? { label: "AYUS", publicPath: CUSTOM_KEYWORD_PATH, sensitivity: 0.6 }
    : { builtin: BuiltInKeyword.Jarvis, sensitivity: 0.6 };
  try {
    return await PorcupineWorker.create(
      accessKey,
      keyword,
      () => onDetectCb?.(),
      { publicPath: MODEL_PATH }
    );
  } catch (err) {
    // Almost always a missing porcupine_params.pv or a bad access key. Warn once
    // and stay disabled so we don't spam the console on every reply.
    console.warn("[wakeword] Porcupine init failed — keyword interrupt off:", err?.message || err);
    disabled = true;
    return null;
  }
}

/** Begin listening for the keyword. Safe to call repeatedly. No-op if unconfigured. */
export async function startWakeListener(onDetect) {
  onDetectCb = onDetect;
  if (disabled || active) return;
  active = true;
  starting = (async () => {
    if (!worker) worker = await build();
    if (!worker || !active) return; // unconfigured, or stopped mid-init
    try {
      await deps.WebVoiceProcessor.subscribe(worker);
    } catch (err) {
      console.warn("[wakeword] mic subscribe failed:", err?.message || err);
      active = false;
    }
  })();
  await starting;
}

/** Stop listening. Releases the mic; keeps the worker warm for the next turn. */
export async function stopWakeListener() {
  if (!active) return;
  active = false;
  await starting; // let a pending subscribe settle before unsubscribing
  if (worker && deps) {
    try {
      await deps.WebVoiceProcessor.unsubscribe(worker);
    } catch {
      /* not subscribed */
    }
  }
}
