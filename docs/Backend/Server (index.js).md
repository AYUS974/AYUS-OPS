---
aliases: [Express, Server, API Server]
tags: [backend, api]
created: 2026-07-22
---

# ⚙️ Server (index.js)

> **File:** `src/index.js` (37 KB)
> The monolith. Express app serving everything: REST API, static files, WebSocket, cron.

---

## What It Does

1. **Express REST API** — all `/api/*` routes, auth-protected
2. **Static file server** — serves `web/dist` (the built React app)
3. **WebSocket server** — real-time voice/chat streaming at `/ws`
4. **Daily cron** — runs the [[Orchestrator]] at `DAILY_CRON` schedule (default 9 AM)
5. **Health check** — `GET /healthz` returns 200

---

## Key API Routes

### Agent Operations
| Method | Route | What |
|--------|-------|------|
| `POST` | `/api/run-agents` | Trigger all agents manually |
| `GET` | `/api/pending` | Get pending actions queue |
| `POST` | `/api/approve/:id` | Approve an action → [[Executor]] |
| `POST` | `/api/reject/:id` | Reject an action |
| `GET` | `/api/digest` | Get latest daily digest |

### AYUS Chat
| Method | Route | What |
|--------|-------|------|
| `POST` | `/api/chat` | Send message to AYUS, get response |
| `POST` | `/api/transcribe` | Audio → text (Groq Whisper) |
| `POST` | `/api/tts` | Text → speech audio |

### Integrations
| Method | Route | What |
|--------|-------|------|
| `GET` | `/api/google/auth-url` | Start Google OAuth flow |
| `GET` | `/api/google/callback` | Google OAuth callback |
| `GET` | `/api/spotify/auth-url` | Start Spotify OAuth flow |
| `GET` | `/api/spotify/callback` | Spotify OAuth callback |

### Data
| Method | Route | What |
|--------|-------|------|
| `GET` | `/api/leads` | List leads |
| `GET` | `/api/invoices` | List invoices |
| `GET` | `/api/content` | List content items |
| `GET` | `/api/candidates` | List candidates |
| `GET` | `/api/analytics/*` | Analytics queries |

---

## Authentication

All API routes verify the user's JWT via Supabase Auth (`src/lib/auth.js`). The `SUPABASE_ANON_KEY` never leaves the browser. The `SUPABASE_SERVICE_ROLE_KEY` is server-side only.

---

## Related

- [[Architecture Overview]]
- [[Orchestrator]]
- [[LLM Abstraction]]
- [[Dashboard]] — Consumes these APIs
