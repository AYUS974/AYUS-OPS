import { useEffect, useRef, useState } from "react";
import { streamSecretaryChat, getConfig } from "../lib/api.js";
import {
  speak,
  stopSpeaking,
  createMicSession,
  onSpeaking,
  voiceSupport,
  speakStreamBegin,
  speakStreamChunk,
  speakStreamEnd,
  whenTtsDone,
  createGeminiLiveSession,
} from "../lib/voice.js";
import "./AyusReactor.css";

/*
  AYUS Reactor — a JARVIS-style voice HUD that sits above the Agent Network.
  Reuses the app's voice engine (voice.js) and the real secretary brain
  (/secretary/chat → LLM). States drive the reactor's color + energy:
  STANDBY · LISTENING · THINKING · SPEAKING.
*/

// Flagship palette (matches ayus-universal-hub): gold idle, cyan active, ember thinking.
const STATE_COLORS = {
  standby: "#e8a838",
  listening: "#2ca5c4",
  thinking: "#c44b2c",
  speaking: "#5fc7dd",
};
const STATE_SUB = {
  standby: "standing by — tap TALK or type",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking…",
};

// From a growing reply `full`, emit each newly-completed sentence past
// `fromIndex` (so AYUS can speak it while the rest still streams in). Returns
// the new index of consumed characters.
function flushSentences(full, fromIndex, emit) {
  const pending = full.slice(fromIndex);
  let lastBoundary = -1;
  for (let i = 0; i < pending.length; i++) {
    if (".!?।\n".includes(pending[i])) lastBoundary = i;
  }
  if (lastBoundary < 0) return fromIndex;
  pending
    .slice(0, lastBoundary + 1)
    .split(/(?<=[.!?।])\s+|\n+/)
    .forEach((s) => {
      const t = s.trim();
      if (t) emit(t);
    });
  return fromIndex + lastBoundary + 1;
}

export default function AyusReactor({ variant = "band", onOpenChat }) {
  const canvasRef = useRef(null);
  const [state, setState] = useState("standby");
  const [listening, setListening] = useState(false);
  const [lastUser, setLastUser] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [input, setInput] = useState("");
  const [convo, setConvo] = useState(false); // always-on hands-free conversation mode

  // refs the render loop reads without re-subscribing
  const stateRef = useRef("standby");
  const levelRef = useRef(0);
  const pulseRef = useRef(0);
  const micLevelRef = useRef(0); // 0..1 live input loudness, drives the listening pulse
  const sessionRef = useRef(null); // active mic dictation session (server-side Whisper)
  const historyRef = useRef([]); // rolling conversation [{role, content}] so AYUS keeps context
  const convoRef = useRef(false); // mirror of `convo` for async callbacks
  const reArmRef = useRef(null); // pending "listen again" timer
  const support = voiceSupport();

  function go(s) {
    stateRef.current = s;
    setState(s);
  }

  // Speaking state from the shared voice engine drives the "speaking" look.
  useEffect(
    () =>
      onSpeaking((isSpeaking, agent) => {
        if (agent === "ayus" || agent == null) {
          if (isSpeaking) go("speaking");
          else if (stateRef.current === "speaking") go("standby");
        }
      }),
    []
  );

  // Restore the conversation across page refreshes.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ayus_reactor_history") || "[]");
      if (Array.isArray(saved) && saved.length) {
        historyRef.current = saved.slice(-12);
        const lastU = [...saved].reverse().find((m) => m.role === "user");
        const lastA = [...saved].reverse().find((m) => m.role === "assistant");
        if (lastU) setLastUser(lastU.content);
        if (lastA) setLastReply(lastA.content);
      }
    } catch {
      /* ignore corrupt history */
    }
  }, []);

  function persistHistory() {
    try {
      localStorage.setItem("ayus_reactor_history", JSON.stringify(historyRef.current));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }

  /* ---------------- mouse parallax ---------------- */
  const pointerRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const onMove = (e) => {
      const p = pointerRef.current;
      p.tx = (e.clientX / window.innerWidth - 0.5) * 2; // -1..1
      p.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  /* ---------------- canvas reactor ---------------- */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    let raf;
    const DPR = Math.min(2, window.devicePixelRatio || 1);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function size() {
      const r = cv.getBoundingClientRect();
      cv.width = r.width * DPR;
      cv.height = r.height * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      // Resizing wipes the bitmap; with reduced motion no loop repaints it,
      // so schedule one frame to redraw the static orb.
      if (reduceMotion) raf = requestAnimationFrame(frame);
    }
    size();
    const ro = new ResizeObserver(size);
    ro.observe(cv);

    const rgba = (hex, a) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    // orbiting energy particles
    const particles = Array.from({ length: 34 }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 0.6 + Math.random() * 0.5,
      spd: (Math.random() * 0.6 + 0.2) * (Math.random() < 0.5 ? -1 : 1),
      sz: Math.random() * 1.4 + 0.5,
    }));
    // background starfield (parallax depth)
    const stars = Array.from({ length: 120 }, () => ({
      x: Math.random(),
      y: Math.random(),
      depth: 0.2 + Math.random() * 0.8,
      ph: Math.random() * Math.PI * 2,
      tw: 0.6 + Math.random() * 1.6,
    }));
    const N = 80;

    function readLevel(st) {
      let target = 0;
      if (st === "listening") {
        // micLevelRef is fed by the mic session's onLevel callback below.
        target = Math.min(1, micLevelRef.current * 3.4);
      } else {
        const t = performance.now() / 1000;
        target = 0.12 + 0.05 * Math.sin(t * 1.6) + pulseRef.current;
      }
      levelRef.current += (target - levelRef.current) * 0.18;
      pulseRef.current *= 0.9;
      // gentle simulated voice energy while speaking
      if (st === "speaking") pulseRef.current = Math.max(pulseRef.current, 0.12 + 0.1 * Math.abs(Math.sin(performance.now() / 110)));
      return levelRef.current;
    }

    function frame(now) {
      const st = stateRef.current;
      const accent = STATE_COLORS[st];
      const lvl = readLevel(st);
      const W = cv.clientWidth, H = cv.clientHeight;
      const cx = W / 2, cy = H / 2;
      const base = Math.min(W, H) * 0.185; /* 0.185: outermost tick ring (*2.66) must stay inside the half-size canvas */
      const spin = now / 1000;
      const tsec = now / 1000;

      // smooth parallax
      const p = pointerRef.current;
      p.x += (p.tx - p.x) * 0.06;
      p.y += (p.ty - p.y) * 0.06;
      const ringDX = p.x * 14, ringDY = p.y * 14; // foreground moves more
      const coreDX = p.x * 6, coreDY = p.y * 6;

      ctx.clearRect(0, 0, W, H);

      // ---- starfield (deepest layer, subtle parallax + twinkle) ----
      for (const s of stars) {
        const px = s.x * W + p.x * 20 * s.depth;
        const py = s.y * H + p.y * 20 * s.depth;
        const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tsec * s.tw + s.ph));
        ctx.globalAlpha = tw * (0.18 + s.depth * 0.42);
        ctx.fillStyle = s.depth > 0.72 ? accent : "#9fd9ea";
        ctx.beginPath();
        ctx.arc(px, py, s.depth * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ---- outer tick bezel ----
      ctx.save();
      ctx.translate(cx + ringDX, cy + ringDY);
      ctx.rotate(spin * 0.18);
      ctx.strokeStyle = accent;
      const tickR = base * 2.52, ticks = 60;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * Math.PI * 2;
        const long = i % 5 === 0;
        ctx.globalAlpha = long ? 0.42 : 0.16;
        ctx.lineWidth = long ? 1.4 : 1;
        const l = long ? base * 0.14 : base * 0.07;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * tickR, Math.sin(a) * tickR);
        ctx.lineTo(Math.cos(a) * (tickR + l), Math.sin(a) * (tickR + l));
        ctx.stroke();
      }
      ctx.restore();

      // ---- concentric tech rings (multi-speed) ----
      [
        { r: base * 1.62, w: 1, segs: 0, sp: 0.06, al: 0.16 },
        { r: base * 1.9, w: 1.4, segs: 4, gap: 0.16, sp: -0.5, al: 0.5 },
        { r: base * 2.18, w: 1.3, segs: 20, gap: 0.6, sp: 0.22, al: 0.3 },
        { r: base * 2.34, w: 1, segs: 0, sp: -0.1, al: 0.12 },
      ].forEach((rg) => {
        ctx.save();
        ctx.translate(cx + ringDX, cy + ringDY);
        ctx.rotate(spin * rg.sp * 2);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = rg.al;
        ctx.lineWidth = rg.w;
        if (rg.segs) {
          for (let i = 0; i < rg.segs; i++) {
            const a0 = (i / rg.segs) * Math.PI * 2;
            const a1 = a0 + (Math.PI * 2 / rg.segs) * rg.gap;
            ctx.beginPath();
            ctx.arc(0, 0, rg.r, a0, a1);
            ctx.stroke();
          }
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, rg.r, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      });

      // ---- circular spectrum ----
      ctx.save();
      ctx.translate(cx + ringDX, cy + ringDY);
      ctx.lineCap = "round";
      const r0 = base * 1.3;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 - Math.PI / 2;
        // Bars pulse with the live input level (lvl) while listening, and breathe
        // ambiently otherwise.
        const mag = (0.25 + 0.75 * Math.abs(Math.sin(i * 0.5 + spin * 2))) * (0.3 + lvl);
        const len = base * 0.1 + mag * base * 0.85 * (0.5 + lvl);
        const x0 = Math.cos(a) * r0, y0 = Math.sin(a) * r0;
        const x1 = Math.cos(a) * (r0 + len), y1 = Math.sin(a) * (r0 + len);
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.3 + mag * 0.55;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.restore();

      // ---- orbiting particles ----
      ctx.save();
      ctx.translate(cx + ringDX, cy + ringDY);
      for (const pp of particles) {
        pp.a += pp.spd * 0.006;
        const pr = base * pp.r * (1.4 + lvl * 0.3);
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(Math.cos(pp.a) * pr, Math.sin(pp.a) * pr, pp.sz, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // ---- core (halo + glow + bloom) ----
      const ccx = cx + coreDX, ccy = cy + coreDY;
      const coreR = base * (0.72 + lvl * 0.55);

      const halo = ctx.createRadialGradient(ccx, ccy, coreR * 0.4, ccx, ccy, coreR * 2.1);
      halo.addColorStop(0, rgba(accent, 0.32));
      halo.addColorStop(0.5, rgba(accent, 0.1));
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 1;
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(ccx, ccy, coreR * 2.1, 0, Math.PI * 2);
      ctx.fill();

      const g = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, coreR * 1.8);
      g.addColorStop(0, accent);
      g.addColorStop(0.25, rgba(accent, 0.5));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ccx, ccy, coreR * 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1;
      ctx.shadowColor = accent;
      ctx.shadowBlur = 26 + lvl * 70;
      const ig = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, coreR);
      ig.addColorStop(0, "#ffffff");
      ig.addColorStop(0.4, accent);
      ig.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = ig;
      ctx.beginPath();
      ctx.arc(ccx, ccy, coreR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // iris lines
      ctx.save();
      ctx.translate(ccx, ccy);
      ctx.rotate(spin * 0.6);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * coreR * 0.3, Math.sin(a) * coreR * 0.3);
        ctx.lineTo(Math.cos(a) * coreR * 0.85, Math.sin(a) * coreR * 0.85);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;

      if (!reduceMotion) raf = requestAnimationFrame(frame);
    }
    // Under reduced motion size() already painted the single static frame; the
    // continuous loop only starts when motion is allowed.
    if (!reduceMotion) raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  /* ---------------- conversation ---------------- */
  async function send(text) {
    const msg = (text || "").trim();
    if (!msg) return;
    setLastUser(msg);
    setLastReply("");

    // If WebSocket session is open and active, send text over WebSocket!
    if (sessionRef.current && sessionRef.current.sendText) {
      sessionRef.current.sendText(msg);
      return;
    }

    go("thinking");
    const history = [...historyRef.current, { role: "user", content: msg }].slice(-12);
    historyRef.current = history;
    persistHistory();

    const voiceOn = localStorage.getItem("ayus_voice") !== "off";
    let full = "";
    let spokenIdx = 0;
    let started = false;

    try {
      const done = await streamSecretaryChat(history, {
        onDelta: (chunk) => {
          if (!chunk) return;
          if (!started) {
            started = true;
            go("speaking");
            if (voiceOn) speakStreamBegin("ayus");
          }
          full += chunk;
          setLastReply(full);
          if (voiceOn) spokenIdx = flushSentences(full, spokenIdx, (s) => speakStreamChunk(s, "ayus"));
        },
      });

      const reply = (done?.message || full).trim() || "…";
      const isReport = reply.includes("===") || reply.includes("---") || reply.includes("##") || reply.length > 500;

      if (isReport) {
        if (voiceOn) stopSpeaking();

        // 1. Sync report to the sidebar chat drawer history
        try {
          const sidebarSaved = JSON.parse(localStorage.getItem("ayus_chat_history") || "[]");
          const updatedSidebar = [
            ...sidebarSaved,
            { role: "user", content: msg, timestamp: new Date().toISOString() },
            {
              role: "assistant",
              content: reply,
              timestamp: new Date().toISOString(),
              toolEvents: done?.toolEvents || [],
              suggestedAction: done?.suggestedAction || null
            }
          ].slice(-30);
          localStorage.setItem("ayus_chat_history", JSON.stringify(updatedSidebar));
        } catch (e) {
          console.error("Failed to sync research report to sidebar:", e);
        }

        // 2. Persist HUD reactor history
        historyRef.current = [...historyRef.current, { role: "assistant", content: "I've compiled the research report for you in the sidebar chat." }].slice(-12);
        persistHistory();

        // 3. Open the sidebar chat drawer
        if (onOpenChat) onOpenChat();

        // 4. Speak a brief summary
        const shortMsg = `Here is the research report compiled by Arjun, sir. I have opened the sidebar chat so you can read the full document.`;
        setLastReply(shortMsg);
        if (voiceOn) {
          await speak(shortMsg, "ayus");
        } else {
          go("standby");
        }
      } else {
        historyRef.current = [...historyRef.current, { role: "assistant", content: reply }].slice(-12);
        persistHistory();
        setLastReply(reply);

        if (voiceOn && started) {
          const tail = full.slice(spokenIdx).trim();
          if (tail) speakStreamChunk(tail, "ayus");
          speakStreamEnd();
        } else {
          go("standby");
        }
      }
      await whenTtsDone();
      if (convoRef.current) scheduleReArm();
    } catch (err) {
      stopSpeaking();
      setLastReply("My apologies — I couldn't reach the core. " + (err?.message || ""));
      go("standby");
      if (convoRef.current) scheduleReArm();
    }
  }

  function startListening() {
    if (sessionRef.current) return;
    if (!support.stt) return;
    stopSpeaking();
    micLevelRef.current = 0;
    
    const liveEnabled = getConfig().geminiLiveEnabled;
    console.log("[AyusReactor] Gemini Live Enabled config:", liveEnabled);

    const startStandardMic = () => {
      sessionRef.current = createMicSession({
        onListening: () => {
          setListening(true);
          go("listening");
        },
        onLevel: (rms) => {
          micLevelRef.current = rms;
        },
        onResult: (text) => send(text),
        onEnd: (gotSpeech) => {
          setListening(false);
          micLevelRef.current = 0;
          sessionRef.current = null;
          if (stateRef.current === "listening") go("standby");
          if (convoRef.current && !gotSpeech) scheduleReArm(300);
        },
        onError: (err) => {
          setListening(false);
          micLevelRef.current = 0;
          sessionRef.current = null;
          go("standby");
          setLastReply(
            err === "not-allowed"
              ? "Allow microphone access in your browser to talk to AYUS, sir."
              : err === "transcribe-failed"
                ? "I didn't catch that — please try again."
                : "I couldn't open the microphone."
          );
          if (convoRef.current && err === "transcribe-failed") scheduleReArm(500);
        },
      });
    };

    if (liveEnabled) {
      try {
        sessionRef.current = createGeminiLiveSession({
          onListening: () => {
            setListening(true);
            go("listening");
          },
          onLevel: (rms) => {
            micLevelRef.current = rms;
          },
          onUserText: (text) => {
            setLastUser(text);
          },
          onText: (text) => {
            setLastReply(text);
            go("speaking");
          },
          onEnd: () => {
            setListening(false);
            micLevelRef.current = 0;
            sessionRef.current = null;
            go("standby");
          },
          onError: (err) => {
            console.warn("[AyusReactor] Gemini Live failed, falling back to standard mic STT:", err);
            sessionRef.current = null;
            startStandardMic();
          },
        });
      } catch (err) {
        console.warn("[AyusReactor] Failed to create Gemini Live session, falling back:", err);
        startStandardMic();
      }
    } else {
      startStandardMic();
    }
  }

  // Re-open the mic shortly, as long as conversation mode is still on and no
  // turn is already running. This is what makes "always-on" continuous.
  function scheduleReArm(delay = 400) {
    clearTimeout(reArmRef.current);
    reArmRef.current = setTimeout(() => {
      if (convoRef.current && !sessionRef.current) startListening();
    }, delay);
  }

  // The TALK button toggles always-on conversation. On → listen continuously and
  // auto-continue after every reply; off → stop and go quiet.
  function toggleConvo() {
    if (!support.stt) return;
    if (convoRef.current) {
      stopConvo();
    } else {
      convoRef.current = true;
      setConvo(true);
      startListening();
    }
  }

  function stopConvo() {
    convoRef.current = false;
    setConvo(false);
    clearTimeout(reArmRef.current);
    stopSpeaking();
    sessionRef.current?.cancel?.();
    sessionRef.current = null;
    micLevelRef.current = 0;
    setListening(false);
    go("standby");
  }
  const hardStop = stopConvo; // ■ STOP fully stops voice + conversation mode

  useEffect(
    () => () => {
      clearTimeout(reArmRef.current);
      sessionRef.current?.cancel?.();
      stopSpeaking();
    },
    []
  );

  return (
    <div className={`ayus-reactor ${variant === "page" ? "is-page" : ""}`} style={{ "--ax": STATE_COLORS[state] }}>
      <div className="ayus-reactor-canvas-wrap">
        <canvas ref={canvasRef} />
        <div className="ayus-scanlines" aria-hidden="true" />
      </div>

      <div className="ayus-reactor-body">
        <div className="ayus-reactor-head">
          <span className="ayus-reactor-brand">A Y U S</span>
          <span className="ayus-reactor-word">
            {state.toUpperCase()} ·{" "}
            {convo && (state === "standby" || state === "listening")
              ? "always-on — just speak"
              : STATE_SUB[state]}
          </span>
        </div>

        <div className="ayus-reactor-transcript">
          {lastUser || lastReply ? (
            <>
              {lastUser && <div className="axu"><b>YOU</b> &nbsp;{lastUser}</div>}
              {lastReply && <div className="axr"><b>AYUS</b> &nbsp;{lastReply}</div>}
            </>
          ) : (
            <div className="idle">Your operations intelligence. Ask for a status, an invoice chase, or anything on the queue.</div>
          )}
        </div>

        <form
          className="ayus-reactor-controls"
          onSubmit={(e) => { e.preventDefault(); if (input.trim()) { send(input.trim()); setInput(""); } }}
        >
          {support.stt && (
            <button
              type="button"
              className={`ayus-talk-btn ${convo ? "live" : ""}`}
              title={convo ? "Always-on conversation is ON — click to stop" : "Click once for hands-free conversation"}
              onClick={toggleConvo}
            >
              {convo ? (listening ? "◉ LISTENING" : "◉ LIVE") : "◉ TALK"}
            </button>
          )}

          <input
            className="ayus-reactor-input"
            placeholder="…or type to AYUS and press Enter"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="button" className="ayus-stop-btn" onClick={hardStop}>■ STOP</button>
        </form>
      </div>
    </div>
  );
}
