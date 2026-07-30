# AYUS Desktop (Electron)

JARVIS-style desktop shell. It spawns the existing `ayus-ops` server
(`../src/index.js`) — which serves the React UI, `/api`, and the live-voice
WebSocket on one port — and loads it in a window. Nothing about the app is
re-implemented; the shell only adds desktop powers.

## What the shell adds
- **System tray** — AYUS stays resident; closing the window hides to tray.
- **Global summon hotkey** — `Ctrl+Shift+Space` (override with `AYUS_HOTKEY`).
- **Floating assistant** — a small always-on-top pill (`/overlay.html`) that
  rides over every other app. Type at AYUS from anywhere; the 👁 button hands it
  a screenshot so it can see and help with whatever's on screen. Toggle with
  `Ctrl+Shift+A` (`AYUS_OVERLAY_HOTKEY`) or the tray. It loads from the same
  origin as the main window, so it shares your login with no extra setup.
- **Always-on-top** toggle (tray menu).
- **Auto-granted microphone** — voice works with no prompt loop.
- **Bundled server** — runs via Electron-as-Node, so a packaged build needs no
  separate Node install.

## Run it
```bash
# 1. from the repo root — build the web app once (the server serves web/dist)
npm install && npm run build

# 2. install + launch the desktop shell
cd desktop
npm install
npm start
```
The shell auto-detects an already-running server (e.g. `npm run dev` on port
3000) and attaches to it; otherwise it starts its own.

Config (env vars):
- `AYUS_PORT` — server port (default 3000)
- `AYUS_HOTKEY` — summon accelerator (default `CommandOrControl+Shift+Space`)
- `AYUS_OVERLAY_HOTKEY` — floating-assistant toggle (default `CommandOrControl+Shift+A`)
- `AYUS_DISABLE_GPU=1` — disable GPU/hardware acceleration. Only needed on
  headless/VM/CI sessions that lack a usable GPU (or its DLLs) and crash with
  "GPU process isn't usable". Leave it OFF on a normal desktop for the smoothest HUD.

Note: the `npm start` launcher (`run.js`) strips `ELECTRON_RUN_AS_NODE` before
starting Electron — if that var is set in your environment it makes Electron run
as plain Node and the app can't boot.

## Known gaps (next steps)
- **Wake word** ("Hello AYUS") uses the Web Speech API, which does **not** work
  in Electron — the TALK button + Gemini Live still work. A local wake-word
  engine (Porcupine) is the follow-up.
- **Audio** still uses the deprecated `ScriptProcessorNode`; move to
  AudioWorklet for glitch-free capture.
- **Packaging** (installer/.exe) not wired yet — add `electron-builder` and a
  real 256×256 `icon.png` (current tray icon is a 1×1 placeholder).
- For voice, set `GEMINI_LIVE_ENABLED=true` + `GEMINI_API_KEY` in the root
  `.env` to use the real-time speech-to-speech path.
