import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { speak, stopSpeaking, createRecognizer, onSpeaking, voiceSupport } from "../lib/voice.js";
import "./AyusReactor.css";

/*
  AYUS Reactor — a JARVIS-style voice HUD that sits above the Agent Network.
  Reuses the app's voice engine (voice.js) and the real secretary brain
  (/secretary/chat → Claude). States drive the reactor's color + energy:
  STANDBY · LISTENING · THINKING · SPEAKING.
*/

const STATE_COLORS = {
  standby: "#22d3ee",
  listening: "#34f5c5",
  thinking: "#f5b830",
  speaking: "#7cd9ff",
};
const STATE_SUB = {
  standby: "standing by — tap TALK or type",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking…",
};

export default function AyusReactor({ variant = "band" }) {
  const canvasRef = useRef(null);
  const [state, setState] = useState("standby");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [lastUser, setLastUser] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [input, setInput] = useState("");

  // refs the render loop reads without re-subscribing
  const stateRef = useRef("standby");
  const levelRef = useRef(0);
  const pulseRef = useRef(0);
  const analyserRef = useRef(null);
  const timeDataRef = useRef(null);
  const freqDataRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const recRef = useRef(null);
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

  /* ---------------- mouse parallax ---------------- */
  const pointerRef = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  useEffect(() => {
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
    function size() {
      const r = cv.getBoundingClientRect();
      cv.width = r.width * DPR;
      cv.height = r.height * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
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
      const an = analyserRef.current;
      if (an && st === "listening") {
        const td = timeDataRef.current;
        an.getByteTimeDomainData(td);
        let sum = 0;
        for (let i = 0; i < td.length; i++) {
          const v = (td[i] - 128) / 128;
          sum += v * v;
        }
        target = Math.min(1, Math.sqrt(sum / td.length) * 3.2);
        an.getByteFrequencyData(freqDataRef.current);
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
      const base = Math.min(W, H) * 0.2;
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
      const fd = freqDataRef.current;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 - Math.PI / 2;
        let mag;
        if (analyserRef.current && st === "listening" && fd) {
          mag = fd[Math.floor((i / N) * fd.length)] / 255;
        } else {
          mag = (0.25 + 0.75 * Math.abs(Math.sin(i * 0.5 + spin * 2))) * (0.3 + lvl);
        }
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

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  /* ---------------- mic analyser (for the listening pulse) ---------------- */
  async function startAnalyser() {
    if (analyserRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ac;
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.8;
      freqDataRef.current = new Uint8Array(an.frequencyBinCount);
      timeDataRef.current = new Uint8Array(an.fftSize);
      src.connect(an);
      analyserRef.current = an;
    } catch {
      /* no mic — the orb still animates ambiently */
    }
  }
  function stopAnalyser() {
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close?.();
    audioCtxRef.current = null;
  }

  /* ---------------- conversation ---------------- */
  async function send(text) {
    const msg = (text || "").trim();
    if (!msg) return;
    setInterim("");
    setLastUser(msg);
    setLastReply("");
    go("thinking");
    try {
      const res = await api("/secretary/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: msg }] }),
      });
      const reply = res?.message || "…";
      setLastReply(reply);
      await speak(reply, "ayus"); // onSpeaking flips state → speaking → standby
    } catch (err) {
      setLastReply("My apologies — I couldn't reach the core. " + (err?.message || ""));
      go("standby");
    }
  }

  function startListening() {
    if (listening) return;
    stopSpeaking();
    startAnalyser();
    const rec = createRecognizer({
      onResult: (t, isFinal) => {
        setInterim(t);
        if (isFinal && t.trim()) {
          setListening(false);
          stopAnalyser();
          send(t.trim());
        }
      },
      onEnd: () => {
        setListening(false);
        stopAnalyser();
        if (stateRef.current === "listening") go("standby");
      },
      onError: () => {
        setListening(false);
        stopAnalyser();
        go("standby");
      },
    });
    if (!rec) {
      go("standby");
      return;
    }
    recRef.current = rec;
    setListening(true);
    go("listening");
    rec.start();
  }
  function stopListening() {
    recRef.current?.stop?.();
    setListening(false);
    stopAnalyser();
    if (stateRef.current === "listening") go("standby");
  }
  function hardStop() {
    stopSpeaking();
    stopListening();
    go("standby");
  }

  useEffect(() => () => { stopAnalyser(); stopSpeaking(); }, []);

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
            {state.toUpperCase()} · {STATE_SUB[state]}
          </span>
        </div>

        <div className="ayus-reactor-transcript">
          {listening && interim ? (
            <div className="interim">{interim}</div>
          ) : lastUser || lastReply ? (
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
              className={`ayus-talk-btn ${listening ? "live" : ""}`}
              onClick={() => (listening ? stopListening() : startListening())}
            >
              {listening ? "◉ LISTENING" : "◉ TALK"}
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
