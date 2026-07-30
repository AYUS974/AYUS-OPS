---
aliases: [TTS, Speech, Voice]
tags: [integration, voice, tts]
created: 2026-07-22
---

# 🔊 Voice System

---

## TTS Provider Chain

AYUS tries providers in order until one works:

| Priority | Provider | Key | Best For |
|----------|----------|-----|----------|
| 1 | **Sarvam AI** (Bulbul v3) | `SARVAM_API_KEY` | Hinglish — code-switches Hindi/English natively |
| 2 | **Cartesia** | `CARTESIA_API_KEY` | High-quality English |
| 3 | **ElevenLabs** | `ELEVENLABS_API_KEY` | Ultra-realistic voices |
| 4 | **Edge TTS** | (free, no key) | Always-available fallback |
| 5 | **Browser voices** | (built-in) | Last resort |

---

## STT (Speech-to-Text)

| Provider | Key | Model |
|----------|-----|-------|
| **Groq Whisper** | `GROQ_API_KEY` | `whisper-large-v3-turbo` |

Config:
```env
GROQ_STT_MODEL=whisper-large-v3-turbo
GROQ_STT_LANGUAGE=en          # Pin language (en/hi/blank=auto)
GROQ_STT_PROMPT=               # Optional vocabulary bias
```

---

## Live Voice (Gemini Live)

Real-time speech-to-speech — like a phone call with AYUS:
```env
GEMINI_LIVE_ENABLED=true
GEMINI_API_KEY=your-key
GEMINI_LIVE_MODEL=models/gemini-2.0-flash-live-001
```

---

## Per-Agent Voices

Each agent can have its own Sarvam voice:
```env
SARVAM_VOICE_AYUS=speaker-name
SARVAM_VOICE_SALES=speaker-name
# etc.
```

---

## Related

- [[AYUS — Secretary Agent]]
- [[AYUS Chat Interface]]
- [[Environment Variables]]
