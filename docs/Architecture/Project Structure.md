---
aliases: [File Structure, Layout]
tags: [architecture, structure]
created: 2026-07-22
---

# 📁 Project Structure

```
ayus-ops/
├── .env                        # Your secrets (never committed)
├── .env.example                # Template with all keys documented
├── package.json                # Root — runs server + web build
├── Dockerfile                  # Multi-stage container build
├── render.yaml                 # One-click Render deploy blueprint
│
├── src/                        # ── Node.js Backend ──
│   ├── index.js                # Express app: auth'd API, cron, serves web/dist
│   │                           #   37KB — routes, WebSocket, static files, all in one
│   ├── orchestrator.js         # Runs all agents in parallel + writes daily digest
│   │
│   ├── agents/                 # ── AI Agent Modules ──
│   │   ├── sales.js            # Arjun — lead qualification + follow-up emails
│   │   ├── finance.js          # Meera — invoice chasing + payment risk
│   │   ├── marketing.js        # Kabir — content review + hook writing
│   │   ├── hr.js               # Isha — candidate screening + interview questions
│   │   ├── cto.js              # Vikram — project update triage (P0-P3)
│   │   ├── secretary.js        # AYUS agent definition (persona, tools)
│   │   └── researcher.js       # Research agent (web search, analysis)
│   │
│   └── lib/                    # ── Shared Libraries ──
│       ├── llm.js              # Provider-agnostic structured LLM call (router)
│       ├── claude.js           # Anthropic Claude API (forced tool-use)
│       ├── gemini.js           # Google Gemini API (responseSchema)
│       ├── groq.js             # Groq API (Llama + Whisper STT)
│       ├── glm.js              # GLM-4 API
│       ├── supabase.js         # Service-role Supabase client
│       ├── auth.js             # JWT verification middleware
│       ├── executor.js         # Runs side effects for approved actions
│       ├── email.js            # Resend email (or console stub)
│       ├── google.js           # Gmail + Calendar OAuth + API
│       ├── spotify.js          # Spotify OAuth + playback control
│       ├── pc-tools.js         # AYUS's guarded laptop access (read/open only)
│       ├── secretaryAgent.js   # AYUS chat logic (29KB — the brain)
│       ├── memory.js           # Conversation memory for AYUS
│       ├── handoffs.js         # Agent-to-agent task delegation
│       ├── inbox.js            # Gmail inbox processing
│       ├── analytics.js        # Data analytics queries
│       ├── edge-tts.js         # Free Microsoft Edge TTS
│       ├── notify.js           # Telegram push notifications
│       ├── ca.js               # Certificate authority setup
│       ├── missions/           # Mission Control engine
│       └── workflows/          # Workflow automation engine
│
├── web/                        # ── React Frontend (Vite) ──
│   ├── index.html              # Entry HTML
│   ├── vite.config.js          # Vite build config + API proxy
│   ├── package.json            # Frontend dependencies
│   └── src/
│       ├── main.jsx            # React entry point
│       ├── App.jsx             # Auth gate: Login or Dashboard
│       ├── index.css           # Global styles (~63KB — full design system)
│       ├── lib/                # API helpers
│       └── components/
│           ├── Dashboard.jsx   # Main dashboard (57KB — the big one)
│           ├── Login.jsx       # Supabase auth login form
│           ├── AyusReactor.jsx # AYUS chat/voice interface
│           ├── CodeWorkspace.jsx # Code editor component
│           ├── LeadPipeline.jsx  # Visual lead pipeline
│           ├── MissionControl.jsx # Mission builder UI
│           └── Workflows.jsx     # Workflow automation UI
│
├── desktop/                    # ── Electron Desktop App ──
│   ├── main.js                 # Electron shell (spawns server, creates window)
│   ├── run.js                  # Launcher (strips ELECTRON_RUN_AS_NODE)
│   ├── overlay-preload.js      # IPC bridge for floating assistant
│   ├── icon.png                # App icon
│   └── package.json            # Electron dependency
│
├── supabase/                   # ── Database Migrations ──
│   ├── schema.sql              # Core tables (run once)
│   ├── seed.sql                # Sample data for first run
│   ├── upgrade-v2.sql          # + HR + CTO tables
│   ├── upgrade-v3.sql          # + missions + workflows
│   ├── upgrade-v4.sql          # + analytics + memory
│   └── upgrade-v5.sql          # + inbox + handoffs
│
├── scripts/                    # Utility scripts
├── workflow-studio/            # Visual workflow editor
└── public/                     # Static assets
```

---

## Key Size Observations

| File | Size | Why |
|------|------|-----|
| `src/index.js` | 37 KB | Entire Express server — routes, WebSocket, cron, all features |
| `src/lib/secretaryAgent.js` | 29 KB | AYUS's brain — tool definitions, reasoning, conversation |
| `web/src/components/Dashboard.jsx` | 57 KB | Full dashboard UI — all tabs, modals, data views |
| `web/src/index.css` | 63 KB | Complete design system — no CSS framework needed |

> [!note] Monolith by Design
> This is intentionally a monolith. One `npm start` runs everything. The server is the API, the static file host, the WebSocket server, AND the cron runner. Deploy one process, get the whole system.

---

## Related

- [[Architecture Overview]]
- [[Tech Stack]]
