---
aliases: [Env, Config, .env]
tags: [setup, config]
created: 2026-07-22
---

# 🔐 Environment Variables

Every configuration key in `.env`, fully documented.

---

## Supabase (Required)

| Key | Description |
|-----|-------------|
| `SUPABASE_URL` | Your project URL (e.g., `https://abc.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side key (never exposed to browser) |
| `SUPABASE_ANON_KEY` | Public key for dashboard auth |

---

## LLM Provider

| Key | Default | Description |
|-----|---------|-------------|
| `LLM_PROVIDER` | `anthropic` | Global provider: `anthropic`, `gemini`, `groq`, `glm` |
| `LLM_PROVIDER_CODE` | (auto) | Override for code-heavy tasks. Defaults to Groq if key set |

---

## Anthropic (Claude)

| Key | Default | Description |
|-----|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key from console.anthropic.com |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model name |

---

## Google Gemini

| Key | Default | Description |
|-----|---------|-------------|
| `GEMINI_API_KEY` | — | API key from aistudio.google.com (free tier!) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Model name |
| `GEMINI_LIVE_ENABLED` | `false` | Enable real-time speech-to-speech |
| `GEMINI_LIVE_MODEL` | `models/gemini-2.0-flash-live-001` | Live model |

---

## Groq

| Key | Default | Description |
|-----|---------|-------------|
| `GROQ_API_KEY` | — | API key from console.groq.com (free tier!) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Chat model |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | Speech-to-text model |
| `GROQ_STT_LANGUAGE` | `en` | Pin STT language (`en`, `hi`, or blank for auto) |
| `GROQ_STT_PROMPT` | — | Optional vocabulary bias for Whisper |

---

## Voice (TTS)

| Key | Description |
|-----|-------------|
| `SARVAM_API_KEY` | Sarvam AI — best for Hinglish |
| `SARVAM_MODEL` | Default: `bulbul:v3` |
| `SARVAM_VOICE_AYUS` | Per-agent voice override |
| `CARTESIA_API_KEY` | Cartesia TTS |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS |

---

## Email

| Key | Default | Description |
|-----|---------|-------------|
| `RESEND_API_KEY` | — | Leave empty = console stub mode |
| `EMAIL_FROM` | `AYUS Labs <onboarding@resend.dev>` | Sender address |

---

## Laptop Access

| Key | Description |
|-----|-------------|
| `PC_ALLOWED_DIRS` | Semicolon-separated folders AYUS can read/search/open |

---

## Wake Word

| Key | Description |
|-----|-------------|
| `PICOVOICE_ACCESS_KEY` | Porcupine wake word engine key |

---

## Google OAuth

| Key | Description |
|-----|-------------|
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Override: `http://localhost:3000/api/google/callback` |

---

## Spotify OAuth

| Key | Description |
|-----|-------------|
| `SPOTIFY_CLIENT_ID` | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | Spotify app client secret |
| `SPOTIFY_REDIRECT_URI` | Override: `http://127.0.0.1:3000/api/spotify/callback` |

---

## Notifications

| Key | Description |
|-----|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID |

---

## Server

| Key | Default | Description |
|-----|---------|-------------|
| `PORT` | `3000` | Server port |
| `DAILY_CRON` | `0 9 * * *` | Agent run schedule (cron syntax) |

---

## Desktop

| Key | Default | Description |
|-----|---------|-------------|
| `AYUS_PORT` | `3000` | Desktop app server port |
| `AYUS_HOTKEY` | `CommandOrControl+Shift+Space` | Summon hotkey |
| `AYUS_OVERLAY_HOTKEY` | `CommandOrControl+Shift+A` | Overlay toggle |
| `AYUS_DISABLE_GPU` | — | Set to `1` for headless/VM |

---

## Related

- [[Setup Guide]]
- [[Tech Stack]]
