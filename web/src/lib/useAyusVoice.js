import { useEffect, useRef, useState } from "react";
import {
  speak,
  stopSpeaking,
  createRecognizer,
  createMicSession,
  onSpeaking,
  voiceSupport,
} from "./voice.js";

// "Hello AYUS" (and common mis-hearings / Devanagari) anywhere in an utterance.
const WAKE_RE = /\b(hello\s+|hey\s+|ok\s+|are\s+|hi\s+)?(ayus|ayush|आयुष|एयुस|एयूस)\b/i;

/**
 * Single owner of all of AYUS's voice behaviour, so the component doesn't have
 * to juggle a web of refs and timers. Three independent layers, one state:
 *
 *  1. Press-to-talk dictation — MediaRecorder + VAD, transcribed server-side by
 *     Groq Whisper (works in every browser, not just Chromium).
 *  2. Hands-free conversation — after each spoken reply the mic re-arms itself,
 *     so the founder can just keep talking. Toggle with the mic button.
 *  3. Ambient "Hello AYUS" wake word — Chromium-only Web Speech, runs while idle.
 *
 * @param {object}   opts
 * @param {boolean}  opts.open        chat panel open?
 * @param {boolean}  opts.busy        is AYUS thinking (a chat request in flight)?
 * @param {(t:string)=>void} opts.onUtterance  called with a finished transcript
 * @param {(m:string,k:string)=>void} opts.showToast
 */
export function useAyusVoice({ open, busy, onUtterance, showToast }) {
  const support = useRef(null);
  if (support.current === null) support.current = voiceSupport();

  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem("ayus_voice") !== "off");
  const [wakeOn, setWakeOn] = useState(() => localStorage.getItem("ayus_wake") !== "off");
  const [listening, setListening] = useState(false); // mic is open, recording a turn
  const [speaking, setSpeaking] = useState(false); // AYUS is talking (TTS)
  const [convo, setConvo] = useState(false); // hands-free conversation mode

  // Mirror every reactive value so the async callbacks below always read the
  // latest — refs don't go stale the way captured state does. Refreshed on
  // each render.
  const st = useRef({});
  st.current.busy = busy;
  st.current.voiceOn = voiceOn;
  st.current.wakeOn = wakeOn;
  st.current.listening = listening;
  st.current.speaking = speaking;
  st.current.convo = convo;
  st.current.onUtterance = onUtterance;
  st.current.showToast = showToast;

  const sessionRef = useRef(null); // active dictation mic session
  const wakeRecRef = useRef(null); // ambient wake-word recognizer
  const reArmTimer = useRef(null); // pending "listen again" timer
  const fn = useRef({}); // latest function refs, for async callers

  function toast(msg, kind) {
    st.current.showToast?.(msg, kind);
  }

  // --- ambient wake word ---------------------------------------------------
  function stopWake() {
    const rec = wakeRecRef.current;
    if (rec) {
      rec.onend = null; // suppress the auto re-arm in our onEnd
      try {
        rec.stop?.();
      } catch {
        /* already stopped */
      }
      wakeRecRef.current = null;
    }
  }

  function startWake() {
    const s = st.current;
    if (!s.wakeOn || !support.current.wake) return;
    if (s.convo || s.listening || s.speaking || s.busy) return; // only while idle
    stopWake();
    const rec = createRecognizer({
      continuous: true,
      onResult: (transcript, isFinal) => {
        const m = transcript.match(WAKE_RE);
        if (!m) return;
        stopWake();
        enterConvo();
        // Said the wake word AND a command in one breath? Run it directly.
        const idx = transcript.toLowerCase().lastIndexOf(m[2].toLowerCase());
        const after = transcript.slice(idx + m[2].length).replace(/^[\s,.!?]+/, "").trim();
        if (after && isFinal) st.current.onUtterance?.(after);
        else speak("Yes sir?", "ayus"); // greet — onSpeaking-end re-arms the mic
      },
      onEnd: () => {
        // Chromium ends continuous recognition every so often — re-arm if idle.
        const s2 = st.current;
        if (s2.wakeOn && !s2.convo && !s2.listening && !s2.speaking && !s2.busy) {
          setTimeout(() => fn.current.startWake(), 300);
        }
      },
      onError: () => {}, // stay quiet on no-speech/aborted
    });
    if (!rec) return;
    wakeRecRef.current = rec;
    try {
      rec.start();
    } catch {
      /* Chromium throws if start() races a previous session — ignore */
    }
  }

  // --- press-to-talk dictation --------------------------------------------
  function startListening() {
    const s = st.current;
    if (s.busy) return; // don't open the mic while AYUS is still answering
    if (!support.current.stt) {
      toast("Voice input needs microphone access in a modern browser", "err");
      return;
    }
    sessionRef.current?.cancel?.(); // never run two mic sessions at once
    stopSpeaking(); // barge-in: the founder speaking cuts AYUS off
    stopWake(); // the dictation mic and the wake mic can't share the input

    sessionRef.current = createMicSession({
      onListening: () => setListening(true), // mic is actually live now
      onResult: (text) => st.current.onUtterance?.(text),
      onEnd: (gotSpeech) => {
        setListening(false);
        sessionRef.current = null;
        // Hands-free but heard nothing and AYUS is idle → just listen again.
        const s2 = st.current;
        if (s2.convo && !gotSpeech && !s2.busy && !s2.speaking) scheduleReArm(250);
      },
      onError: (err) => {
        setListening(false);
        sessionRef.current = null;
        if (err === "not-allowed") toast("Allow microphone access to talk to AYUS", "err");
        else if (err === "mic-failed") toast("Couldn't open the microphone", "err");
        else if (err === "transcribe-failed") toast("Didn't catch that — try again", "err");
      },
    });
  }

  function scheduleReArm(delay = 350) {
    clearTimeout(reArmTimer.current);
    reArmTimer.current = setTimeout(() => {
      const s = st.current;
      if (s.busy || s.speaking) return; // something else is happening — let it finish
      if (s.convo) fn.current.startListening(); // still chatting → reply mic
      else fn.current.startWake(); // idle → resume ambient wake word
    }, delay);
  }

  // --- conversation mode ---------------------------------------------------
  function enterConvo() {
    st.current.convo = true;
    setConvo(true);
  }
  function exitConvo() {
    st.current.convo = false;
    setConvo(false);
  }

  // Mic button. Three intents depending on what's happening:
  //  - actively recording → stop & send now (so a slow VAD never traps a turn)
  //  - in a conversation but mic idle (AYUS speaking/thinking) → leave the convo
  //  - otherwise → start a hands-free conversation
  function toggleMic() {
    const s = st.current;
    console.log(
      "%c[voice]",
      "color:#22d3ee",
      "mic clicked — support:",
      support.current,
      "secureContext:",
      window.isSecureContext,
      "mediaDevices:",
      Boolean(navigator.mediaDevices?.getUserMedia),
      "MediaRecorder:",
      typeof window.MediaRecorder,
      "| listening:",
      s.listening,
      "convo:",
      s.convo
    );
    if (!support.current.stt) {
      toast("Voice input needs microphone access in a modern browser", "err");
      return;
    }
    if (s.listening) {
      sessionRef.current?.stop?.(); // force-transcribe whatever was captured
      return;
    }
    if (s.convo) {
      exitConvo();
      clearTimeout(reArmTimer.current);
      sessionRef.current?.cancel?.();
      sessionRef.current = null;
      startWake(); // back to ambient wake-word listening
      return;
    }
    enterConvo();
    startListening();
  }

  // --- replies / outgoing requests ----------------------------------------
  // Speak a reply when un-muted; either way keep a conversation flowing (when
  // muted there's no TTS, so re-arm the mic ourselves).
  function speakReply(text) {
    // Un-muted: speak — onSpeaking's end handler re-arms the mic / wake word.
    // Muted: no TTS fires, so re-arm here (resume the wake word, or keep a
    // hands-free conversation going).
    if (st.current.voiceOn && text) speak(text, "ayus");
    else scheduleReArm();
  }

  // Call as a chat request goes out: silence the wake word so AYUS thinking /
  // speaking can't self-trigger it.
  function beginRequest() {
    stopWake();
  }

  // --- settings toggles ----------------------------------------------------
  function toggleVoice() {
    const next = !voiceOn;
    st.current.voiceOn = next;
    setVoiceOn(next);
    localStorage.setItem("ayus_voice", next ? "on" : "off");
    if (!next) stopSpeaking();
  }

  function toggleWake() {
    const next = !wakeOn;
    st.current.wakeOn = next;
    setWakeOn(next);
    localStorage.setItem("ayus_wake", next ? "on" : "off");
    if (next) startWake();
    else stopWake();
  }

  // Expose the latest closures so timers/recognizer callbacks call current code.
  fn.current = { startWake, startListening, scheduleReArm };

  // Track TTS so the header can show "speaking…" and so we re-arm the mic the
  // instant AYUS stops talking (hands-free) or resume the wake word (idle).
  useEffect(
    () =>
      onSpeaking((isSpeaking) => {
        st.current.speaking = isSpeaking;
        setSpeaking(isSpeaking);
        if (!isSpeaking) scheduleReArm(); // small gap baked into the timer
      }),
    []
  );

  // Start ambient listening when the panel opens; shut everything down when it
  // closes or unmounts.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => fn.current.startWake(), 400);
      return () => clearTimeout(t);
    }
    exitConvo();
    stopSpeaking();
    sessionRef.current?.cancel?.();
    sessionRef.current = null;
    stopWake();
    clearTimeout(reArmTimer.current);
    setListening(false);
  }, [open]);

  useEffect(
    () => () => {
      stopSpeaking();
      sessionRef.current?.cancel?.();
      stopWake();
      clearTimeout(reArmTimer.current);
    },
    []
  );

  return {
    support: support.current,
    voiceOn,
    wakeOn,
    listening,
    speaking,
    convo,
    toggleVoice,
    toggleWake,
    toggleMic,
    speakReply,
    beginRequest,
  };
}
