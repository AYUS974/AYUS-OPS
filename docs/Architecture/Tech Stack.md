---
aliases: [Stack, Technologies]
tags: [architecture, stack]
created: 2026-07-22
---

# 🛠️ Tech Stack

## Backend

| Technology | Purpose | File(s) |
|------------|---------|---------|
| **Node.js 20+** | Runtime (ESM modules) | `package.json` |
| **Express 4** | HTTP server, REST API, static file serving | `src/index.js` |
| **Supabase JS v2** | Postgres client, auth verification | `src/lib/supabase.js` |
| **WebSocket (ws)** | Real-time voice/chat streaming | `src/index.js` |
| **node-cron** | Daily agent scheduling | `src/index.js` |
| **dotenv** | Environment variable loading | `.env` |

## AI / LLM

| Technology | Purpose | File(s) |
|------------|---------|---------|
| **Anthropic Claude** (Sonnet) | Primary LLM — forced tool-use for JSON | `src/lib/claude.js` |
| **Google Gemini** (Flash) | Free-tier alternative, Live voice | `src/lib/gemini.js` |
| **Groq** (Llama 3.3 70B) | Fast inference, STT (Whisper) | `src/lib/groq.js` |
| **GLM-4** | Additional provider | `src/lib/glm.js` |
| **LLM Router** | Per-task model routing ("jaisa task, waisa model") | `src/lib/llm.js` |

## Voice / TTS

| Technology | Purpose |
|------------|---------|
| **Sarvam AI** (Bulbul v3) | Primary — best for Hinglish, Hindi-English code-switching |
| **Cartesia** | Secondary TTS |
| **ElevenLabs** | Premium realistic voices |
| **msedge-tts** | Free fallback (Edge browser voices) |
| **Groq Whisper** | Speech-to-text (mic input) |
| **Gemini Live** | Real-time speech-to-speech (optional) |

## Frontend

| Technology | Purpose | File(s) |
|------------|---------|---------|
| **React 18** | UI framework | `web/src/` |
| **Vite** | Build tool + dev server | `web/vite.config.js` |
| **Supabase JS** (browser) | Auth + realtime subscriptions | `web/src/lib/api.js` |
| **Vanilla CSS** | Styling (no Tailwind) | `web/src/index.css` (~63KB!) |

## Desktop

| Technology | Purpose | File(s) |
|------------|---------|---------|
| **Electron 33** | Desktop shell (JARVIS mode) | `desktop/` |
| **desktopCapturer** | Screenshot for overlay "see my screen" | `desktop/main.js` |
| **globalShortcut** | `Ctrl+Shift+Space` summon hotkey | `desktop/main.js` |

## Integrations

| Technology | Purpose | File(s) |
|------------|---------|---------|
| **Resend** | Transactional email delivery | `src/lib/email.js` |
| **Google APIs** | Gmail send/reply + Calendar events | `src/lib/google.js` |
| **Spotify Web API** | Music playback control | `src/lib/spotify.js` |
| **Telegram Bot API** | Push notifications (daily digest) | `src/lib/notify.js` |

## Deployment

| Technology | Purpose | File(s) |
|------------|---------|---------|
| **Render** | Cloud hosting (blueprint) | `render.yaml` |
| **Docker** | Container build (multi-stage) | `Dockerfile` |

---

## Related

- [[Architecture Overview]]
- [[Project Structure]]
