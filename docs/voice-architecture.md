# Low-latency voice assistant architecture

How the AYUS voice stack is built, and how to lift it into another project.

Two independent paths ship here. Use the one that matches the product:

| | **Live path** (what feels instant) | **Cascade path** (portable fallback) |
|---|---|---|
| Transport | one WebSocket, audio in *and* out | HTTP request per stage |
| Pipeline | mic PCM → Gemini Live → speech | mic → STT → LLM → TTS |
| First audio | ~300–700 ms after you stop talking | ~1.5–3 s |
| Barge-in | server-side VAD, model stops itself | keyword spotter stops playback |
| Cost of a turn | one bidirectional stream | 3 API calls |
| Needs | a realtime model (Gemini Live) | any LLM + any STT + any TTS |

The cascade path is not dead weight — it runs on any model, works when the
realtime API is down or the feature flag is off, and is the only path that gives
you the exact TTS voice you licensed.

---

## 1. Live path

```
browser mic ──16 kHz PCM16──▶ your server ──▶ Gemini Live API
                                  │                 │
browser speaker ◀─24 kHz PCM16────┴─────────────────┘
                                  │
                              tool calls (your code runs them)
```

### 1.1 Why a server proxy instead of browser → Google directly

1. The API key never reaches the client.
2. Your auth (Supabase JWT here) gates the socket.
3. Tool calls execute on your machine — filesystem, OS control, database, the
   things a browser cannot do.
4. One place to inject the system prompt and live business context.

The proxy is thin: it holds two sockets and forwards between them.

### 1.2 Capture (browser)

```js
micStream = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
});
const ctx = new AudioContext();
const node = ctx.createScriptProcessor(2048, 1, 1);
node.onaudioprocess = (e) => {
  const pcm16 = floatTo16BitPCM(downsample(e.inputBuffer.getChannelData(0), ctx.sampleRate, 16000));
  ws.send(pcm16.buffer);           // raw binary frame, ~128 ms of audio
};
```

Non-negotiables:

- **16 kHz, mono, signed 16-bit little-endian.** The hardware gives you 44.1/48
  kHz float — you must downsample and quantise yourself.
- **`echoCancellation: true`** or the model hears its own voice and interrupts
  itself forever.
- Send **raw binary**, not base64, on your own socket. Base64 costs 33% more
  bytes on the leg you control; convert only at the Google boundary.
- `ScriptProcessorNode` is deprecated but works everywhere and is 2 lines.
  `AudioWorklet` is the correct upgrade when you need it off the main thread.

### 1.3 The proxy (server)

Open the upstream socket per client and send **setup as the first message**:

```js
const url = `wss://generativelanguage.googleapis.com/ws/`
  + `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;

{
  setup: {
    model: "models/gemini-3.1-flash-live-preview",
    generationConfig: {
      responseModalities: ["AUDIO"],                        // AUDIO only on live models
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
    },
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: [{ functionDeclarations }],
    inputAudioTranscription: {},                            // captions of the user
    outputAudioTranscription: {},                           // captions of the model
  }
}
```

Then forward audio each way:

```js
// browser → Google
{ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: base64 } } }

// Google → browser: serverContent.modelTurn.parts[].inlineData.data (base64 PCM16 @ 24 kHz)
```

Auth note: browsers cannot set headers on a WebSocket, so the token rides in the
query string and is verified during the HTTP upgrade, before the socket is
accepted:

```js
server.on("upgrade", (req, socket, head) => {
  const token = new URL(req.url, "http://x").searchParams.get("token");
  verifyToken(token).then((user) => {
    if (!user) return socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"), socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
});
```

### 1.4 Playback with a jitter buffer (browser)

Audio arrives in small chunks. Playing each one on arrival gives clicks and
gaps. Schedule them back to back on the AudioContext clock instead:

```js
let nextPlayTime = ctx.currentTime;

function playPCMChunk(base64) {
  const int16 = new Int16Array(bytesFrom(base64).buffer);
  const buf = ctx.createBuffer(1, int16.length, 24000);      // model output is 24 kHz
  const ch = buf.getChannelData(0);
  for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  if (nextPlayTime < ctx.currentTime) nextPlayTime = ctx.currentTime;   // underrun: catch up
  src.start(nextPlayTime);
  nextPlayTime += buf.duration;
  activeSources.push(src);                                   // needed for barge-in
}
```

**Input is 16 kHz, output is 24 kHz.** Mixing them up gives chipmunk or drunk
speech — the single most common bug in this stack.

### 1.5 Barge-in

The model's own VAD detects you talking over it and sends
`serverContent.interrupted`. Everything already scheduled must be killed:

```js
if (sc.interrupted) {
  for (const s of activeSources) { try { s.stop(); } catch {} }
  activeSources = [];
  nextPlayTime = ctx.currentTime;
}
```

Without this the model has moved on but the speaker keeps talking for seconds.

### 1.6 Captions

`inputAudioTranscription` / `outputAudioTranscription` in setup make the server
stream text alongside the audio. Accumulate per turn, reset on `turnComplete`:

```js
if (sc.inputTranscription?.text)  userText  += sc.inputTranscription.text;
if (sc.outputTranscription?.text) modelText += sc.outputTranscription.text;
if (sc.turnComplete) userText = modelText = "";
```

### 1.7 Tools, and not going silent

A normal (blocking) tool call freezes the conversation until it returns. Fine at
200 ms, fatal at 30 s — the assistant just goes mute mid-sentence.

Declare slow tools non-blocking, and interrupt with the result when it lands:

```js
// declaration
{ name: "delegate_to_researcher", description, parameters, behavior: "NON_BLOCKING" }

// response, whenever it finishes
{ toolResponse: { functionResponses: [{
    id, name,
    response: { output: result, scheduling: "INTERRUPT" },   // WHEN_IDLE / SILENT also exist
}] } }
```

Two rules learned the hard way:

- A non-blocking call leaves the model free — and it fills the gap by calling
  the same tool again, and by "checking progress". Keep one run in flight per
  tool name and reply to duplicates with an explicit *"already running, do not
  call again, the result will reach you"*.
- Every model call behind a voice tool needs a **deadline**. A provider that
  answers 429 with "retry in 54s" will happily hold the conversation open for
  minutes. Fail fast and let the assistant say so out loud.

### 1.8 Live-path gotchas

- `realtimeInput.mediaChunks` is **removed**. Use `realtimeInput.audio`. The
  socket dies with `1007 - realtime_input.media_chunks is deprecated`.
- Live model names rotate fast. List them before assuming:
  `GET /v1beta/models` → keep those whose `supportedGenerationMethods`
  contains `bidiGenerateContent`.
- Live models accept `responseModalities: ["AUDIO"]` only; `["TEXT"]` is
  rejected with 1007. Use `outputAudioTranscription` when you want text.
- Close code **1007 = your message was invalid**, 1008 = model/auth wrong. The
  reason string is capped at 123 bytes, so it truncates.
- Setup arriving seconds late is fine (tested to 12 s) — don't contort your code
  to send it faster.

---

## 2. Cascade path

Used when the realtime model is off. Every stage is swappable.

### 2.1 Turn capture with VAD auto-stop

`MediaRecorder` for the bytes, an `AnalyserNode` for the level:

```js
recorder = new MediaRecorder(stream, { mimeType: pickSupported() });   // webm/opus, mp4 on Safari
// RMS loop: wait for speech, then ~900 ms of silence → stop and send
if (rms > 0.045) { spoke = true; silentMs = 0; }
else if (spoke && (silentMs += dt) > 900) stopListening();
```

Two details that matter more than they look:

- Drive the loop from `requestAnimationFrame` **and** time it off the audio
  clock, not `setInterval`. Background tabs throttle timers to once a minute;
  the silence detector then never fires and the mic hangs open.
- Always keep a hard cap (12 s here) so a stuck detector still sends something.

### 2.2 STT — server side, not the browser

`webkitSpeechRecognition` is Chromium-only and absent in Electron. Posting the
blob to your own endpoint and running Whisper (Groq is fast and cheap) works in
every browser and in the desktop shell:

```
POST /api/stt?ext=webm   Content-Type: audio/webm   body: the blob
→ { text: "..." }
```

### 2.3 Speak while the LLM is still writing

The single biggest latency win on this path: don't wait for the full answer.
Stream the completion, cut it at sentence boundaries, and start TTS on sentence
one while the model writes sentence two.

### 2.4 TTS provider chain

Try in order, fall through on error, and keep the browser's built-in
`speechSynthesis` as the last resort so the assistant is never mute:

```
Sarvam (Bulbul — best Hinglish) → Cartesia → ElevenLabs → browser speechSynthesis
```

A silent failure here shows up as the assistant suddenly sounding like a robot:
that's the browser fallback, and it means every hosted provider errored.

### 2.5 Wake word

Web Speech is Chromium-only and unusable in Electron. Porcupine (WASM, offline,
free tier) works everywhere:

- Listen for the keyword **only while the assistant is speaking** — the mic is
  otherwise idle, so there's no dual-mic clash.
- On a hit: stop playback, open the mic. That's hands-free barge-in on a path
  that has no server VAD.
- Lazy-load the WASM only when a key is configured; it's a large blob.

---

## 3. Desktop shell (why the pill keeps listening)

A browser tab stops being a good assistant the moment you switch windows:
timers throttle, the mic loses priority, and the tab may be discarded.

The fix is an Electron shell that does **not** re-implement the app:

- It spawns the existing server and loads `http://127.0.0.1:PORT` in a window,
  so same-origin means `/api`, the WebSocket, and mic permission all work
  unchanged.
- A second frameless, transparent, `alwaysOnTop: "screen-saver"` window loads
  `/overlay.html` from the same origin — so it shares the login session in
  localStorage with zero token plumbing.
- That pill opens the live socket on load and holds it. It floats over every
  other app, so the assistant keeps listening while you work elsewhere.
- `session.setPermissionRequestHandler` auto-grants the mic; no prompt per
  launch.
- Screen awareness needs no capture from the pill: the assistant calls its own
  `screen_read` tool, which screenshots server-side on the same machine.

If the overlay is a plain static page it cannot import your app's voice module.
Make it a real bundler entry (Vite MPA `rollupOptions.input`) and it reuses the
same session code as the dashboard instead of a second copy that drifts.

---

## 4. Porting checklist

1. WebSocket proxy route with token-in-query auth on upgrade.
2. Setup message: model, `AUDIO` modality, voice, system prompt, tools,
   both transcription flags.
3. Browser capture: 16 kHz mono PCM16, echo cancellation on, raw binary frames.
4. Browser playback: 24 kHz buffers scheduled on `nextPlayTime`, sources tracked.
5. Handle `interrupted` → stop every scheduled source.
6. Tools: blocking for fast ones, `NON_BLOCKING` + `INTERRUPT` for slow ones,
   one-in-flight guard, deadlines on every upstream model call.
7. Cascade fallback behind a flag: MediaRecorder + VAD → STT → streaming LLM →
   sentence-chunked TTS chain → browser speech as last resort.
8. Desktop: Electron shell + always-on-top overlay on the same origin.

## 5. Latency budget (live path, measured feel)

| Stage | Cost |
|---|---|
| Mic frame → server | ~128 ms of audio per frame, negligible transit on localhost |
| Server → Google | one extra hop; keep the server near the user, not the model |
| Model turn start | ~300–500 ms after silence |
| First audio → speaker | one buffer, ~20–60 ms |

What actually ruins it, in order: waiting for a full LLM answer before speaking,
blocking tool calls, provider retry backoff, and re-opening the socket per turn.
Keep the socket open for the whole conversation.
