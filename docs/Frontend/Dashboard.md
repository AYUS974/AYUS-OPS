---
aliases: [UI, React Dashboard, Frontend]
tags: [frontend, dashboard]
created: 2026-07-22
---

# 🌐 Dashboard

> **File:** `web/src/components/Dashboard.jsx` (57 KB)
> The main React UI — everything you interact with.

---

## Features

### Sidebar Navigation
- **AYUS** — Chat/voice interface ([[AYUS Chat Interface]])
- **Dashboard** — Approval queue + stats
- **Leads** — Lead pipeline ([[UI Components]])
- **Mission Control** — Build missions/projects
- **Workflows** — Automation builder
- **Code Workspace** — Code editor

### Approval Queue
- See all [[Pending Actions]] from every agent
- **Approve** → triggers [[Executor]] → real side effect
- **Reject** → archived, no action taken
- Each card shows: agent, type, title, summary, payload preview

### Stats & Digests
- Latest [[Orchestrator]] run results
- Daily digest (Hinglish morning briefing)
- Agent run history + error logs

### "Run Agents Now" Button
Triggers all agents on-demand (same as the daily cron)

---

## Auth Flow

1. App loads → checks Supabase session
2. No session → shows [[UI Components|Login]] form
3. Login via Supabase Auth (email + password)
4. Session stored → Dashboard renders
5. Every API call includes JWT for verification

---

## Integration Panel (Sidebar)
- **Connect Google** → Gmail + Calendar OAuth
- **Connect Spotify** → Spotify OAuth
- Status indicators for each connection

---

## Related

- [[UI Components]] — All component files
- [[AYUS Chat Interface]]
- [[Server (index.js)]] — API it consumes
