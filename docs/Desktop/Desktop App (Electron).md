---
aliases: [Electron, Desktop, JARVIS Shell]
tags: [desktop, electron]
created: 2026-07-22
---

# 🖥️ Desktop App (Electron)

> **Directory:** `desktop/`
> **Main file:** `desktop/main.js` (12.7 KB)

JARVIS-style desktop shell. Same app as the web — just wrapped in Electron with desktop superpowers.

---

## What the Shell Adds

| Feature | Description |
|---------|-------------|
| **System Tray** | AYUS stays resident. Closing the window hides to tray |
| **Global Summon** | `Ctrl+Shift+Space` — show/hide AYUS from anywhere |
| **Floating Assistant** | [[Overlay Widget]] — always-on-top pill over other apps |
| **Always-on-top** | Toggle from tray menu |
| **Auto Mic** | Microphone auto-granted, no permission popup |
| **Bundled Server** | Runs via `ELECTRON_RUN_AS_NODE` — no separate Node needed |
| **Single Instance** | Second launch just summons the running window |

---

## How It Works

```
npm start (in desktop/)
    ↓
run.js → strips ELECTRON_RUN_AS_NODE → spawns Electron
    ↓
main.js:
  1. Check if server already running on :3000
  2. If not → spawn src/index.js as child process
  3. Wait for server health check (/healthz)
  4. Create BrowserWindow → load http://127.0.0.1:3000
  5. Create system tray + register hotkeys
  6. After 800ms → create overlay window
```

---

## Launch Commands

```powershell
# From repo root — build web first
npm install && npm run build

# Install Electron + launch
cd desktop
npm install
npm start

# If GPU crashes (VM/headless):
$env:AYUS_DISABLE_GPU="1"; npm start
```

---

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `AYUS_PORT` | `3000` | Server port |
| `AYUS_HOTKEY` | `CommandOrControl+Shift+Space` | Summon/hide accelerator |
| `AYUS_OVERLAY_HOTKEY` | `CommandOrControl+Shift+A` | Overlay toggle |
| `AYUS_DISABLE_GPU` | unset | Set to `1` for headless/VM |

---

## Known Gaps

- **Wake word** ("Hello AYUS") doesn't work in Electron (Web Speech API limitation). TALK button + Gemini Live still work. Fix: Porcupine wake word engine.
- **Audio capture** uses deprecated `ScriptProcessorNode`. Fix: AudioWorklet.
- **Packaging** (.exe installer) not wired yet. Needs `electron-builder`.

---

## Related

- [[Overlay Widget]] — Floating assistant
- [[AYUS — Secretary Agent]]
- [[Setup Guide]]
