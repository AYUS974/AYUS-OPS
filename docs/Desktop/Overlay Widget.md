---
aliases: [Overlay, Floating Assistant, Pill]
tags: [desktop, overlay]
created: 2026-07-22
---

# 🫧 Overlay Widget — Floating Assistant

The overlay is a small, frameless, always-on-top window that floats above every other app — even fullscreen windows.

---

## What It Does

- **Always visible** — rides above every app, across all workspaces
- **Same origin** — loads `/overlay.html` from the same server, shares login session
- **Screen vision** — 👁 button captures a screenshot via `desktopCapturer` and gives it to AYUS
- **Resizable** — grows upward to fit content, anchored at bottom edge
- **Draggable** — move it anywhere on screen

---

## Toggle

- **Hotkey:** `Ctrl+Shift+A` (override with `AYUS_OVERLAY_HOTKEY`)
- **Tray menu:** "Show / Hide floating assistant"

---

## GPU Fallback

If the GPU process crashes (common in VMs), the overlay switches from transparent to opaque mode automatically:
- `gpuOk = true` → transparent background, floating feel
- `gpuOk = false` → opaque dark background with CSS border-radius

---

## IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `capture-screen` | overlay → main | Get screenshot as data URL |
| `overlay-resize` | overlay → main | Resize window to fit content |
| `overlay-hide` | overlay → main | Hide the overlay |

---

## Related

- [[Desktop App (Electron)]]
- [[AYUS — Secretary Agent]]
