---
aliases: [AYUS, Secretary, JARVIS, Assistant]
tags: [agent, secretary, ayus, jarvis]
created: 2026-07-22
---

# 🤖 AYUS — Secretary Agent (JARVIS)

> **Files:** `src/agents/secretary.js` (3.6 KB) + `src/lib/secretaryAgent.js` (29 KB)
> **Data source:** All tables + chat + laptop
> **Action types:** `manual_task`, `gmail_send`, `gmail_reply`, `calendar_event`

---

## The JARVIS-Style Assistant

AYUS is your personal operations intelligence — a JARVIS-style assistant you can **type to or talk to**. It has real tools, not just chat.

---

## How to Talk to AYUS

1. **Text:** Open the AYUS page in the sidebar → type your message
2. **Voice:** Click the 🎤 mic button → speak (understands Hinglish!)
3. **Desktop overlay:** `Ctrl+Shift+A` → small floating pill over any app

---

## Tools AYUS Has

### 💻 Laptop Access (Guarded)
| Tool | What it does |
|------|-------------|
| **Open app** | Launch Spotify, Chrome, VS Code, etc. |
| **Play music** | "Play some Arijit Singh on Spotify" |
| **Open website** | Opens URL in default browser |
| **Search files** | Find files — **only in `PC_ALLOWED_DIRS`** |
| **Read files** | Read file contents — **only in `PC_ALLOWED_DIRS`** |
| **Open file** | Open a file with its default app |

> [!warning] Safety Boundary
> AYUS **cannot** delete, modify, move, or install anything. Those tools don't exist in its toolkit. Anything destructive becomes an approval item.

### 📧 Communication
| Tool | What it does |
|------|-------------|
| **Draft email** | Creates email proposal for your approval |
| **Gmail send/reply** | Via [[Google Integration]] (if connected) |
| **Calendar event** | Creates Google Calendar events |
| **Reminder/to-do** | Adds to approval queue |

### 📊 Data Access
| Tool | What it does |
|------|-------------|
| **Query leads** | Check lead pipeline status |
| **Query invoices** | Check payment status |
| **Query content** | Review content pipeline |
| **Analytics** | Run data analysis queries |

### 👁️ Screen Vision (Desktop Only)
The [[Overlay Widget]] has an 👁 button that captures a screenshot and hands it to AYUS, so it can see what's on your screen and help contextually.

---

## Voice System

AYUS speaks with a voice! The provider chain:
1. **Sarvam** (primary) — best for Hinglish (Bulbul model, code-switches Hindi/English)
2. **Cartesia** — secondary
3. **ElevenLabs** — premium realistic voices
4. **Edge TTS** — free browser voices (always available fallback)

### Live Voice Mode
Set `GEMINI_LIVE_ENABLED=true` + `GEMINI_API_KEY` for real-time speech-to-speech (Gemini Live) — like a phone call with AYUS.

---

## Memory

AYUS remembers your conversations within a session. Conversation memory is managed in `src/lib/memory.js`.

---

## The Secretary Agent (Daily Cron)

Besides the interactive chat, AYUS also runs as a daily agent via the [[Orchestrator]]:
- Generates a morning ops summary
- Flags items that need attention
- Creates `manual_task` proposals for administrative reminders

---

## Related

- [[AYUS Chat Interface]] — Frontend UI
- [[PC Tools]] — Laptop access details
- [[Voice System]] — TTS providers
- [[Desktop App (Electron)]] — JARVIS desktop shell
- [[Overlay Widget]] — Floating assistant
