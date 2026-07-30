---
aliases: [AYUS UI, Chat, Voice Interface, Reactor]
tags: [frontend, ayus, voice]
created: 2026-07-22
---

# 💬 AYUS Chat Interface

> **File:** `web/src/components/AyusReactor.jsx` (22 KB) + `AyusReactor.css` (6 KB)

---

## Features

### Text Chat
- Type messages to AYUS
- Streaming responses (real-time typing effect)
- Message history within session

### Voice Input 🎤
- Click mic button to start recording
- Audio sent to Groq Whisper (STT) → text → AYUS → response
- Supports Hinglish (Hindi-English mix)
- Pin language with `GROQ_STT_LANGUAGE` (default: `en`)

### Voice Output 🔊
- AYUS speaks responses aloud
- Provider chain: Sarvam → Cartesia → ElevenLabs → Edge TTS → browser voices
- Each agent can have its own voice

### Gemini Live Mode (Optional)
- Real-time speech-to-speech
- Like a phone call with AYUS
- Requires `GEMINI_LIVE_ENABLED=true` + `GEMINI_API_KEY`

---

## How Voice Works

```
You speak → Mic capture (browser MediaRecorder)
    ↓
Audio blob → POST /api/transcribe
    ↓
Groq Whisper STT → text
    ↓
POST /api/chat (text) → AYUS response (text)
    ↓
POST /api/tts (response text) → audio
    ↓
Play audio in browser
```

---

## Related

- [[AYUS — Secretary Agent]] — The brain behind the chat
- [[Voice System]] — TTS providers
- [[Desktop App (Electron)]] — Desktop version
- [[Overlay Widget]] — Floating mini-version
