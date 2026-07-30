---
aliases: [Architecture]
tags: [architecture, overview]
created: 2026-07-22
---

# 📐 Architecture Overview

AYUS Ops follows a **propose → approve → execute** architecture. AI agents analyze live data, but never act — every action lands in a queue for human approval.

---

## System Diagram

```
┌──────────────────────────────────────────────────────┐
│                    YOU (CEO)                          │
│         React Dashboard / Desktop App                │
│    approve / reject / run agents / chat with AYUS    │
└───────────────────────┬──────────────────────────────┘
                        │ Supabase Auth (JWT)
                        ▼
┌──────────────────────────────────────────────────────┐
│              Node.js / Express Server                │
│                   (src/index.js)                      │
│                                                      │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ REST API │  │ WebSocket│  │  Static Files    │   │
│  │ /api/*   │  │ /ws      │  │  web/dist        │   │
│  └────┬─────┘  └────┬─────┘  └──────────────────┘   │
│       │              │                               │
│  ┌────┴──────────────┴──────────────────────────┐   │
│  │           Orchestrator (daily cron)            │   │
│  │     runs all agents in parallel at 9 AM       │   │
│  └──┬────┬────┬────┬────┬────┬──────────────────┘   │
│     │    │    │    │    │    │                        │
│  Sales Finance Mkt  HR  CTO Secretary                │
│  Arjun Meera  Kabir Isha Vikram AYUS                 │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│                  Supabase (Postgres)                  │
│                                                      │
│  leads · invoices · content_items · candidates       │
│  project_updates · pending_actions · agent_runs      │
│  daily_digests · sent_emails                         │
└──────────────────────────────────────────────────────┘
```

---

## Request Lifecycle

1. **Data arrives** — leads, invoices, content, candidates, project updates land in Supabase tables (manually, via forms, or API)
2. **Agents analyze** — The [[Orchestrator]] runs all agents daily (or on-demand). Each agent fetches its data, sends it to the [[LLM Abstraction]] with a persona + JSON schema, and gets structured analysis back
3. **Proposals queue** — Agents write results to [[Pending Actions]] (`pending_actions` table) — never execute directly
4. **You decide** — The [[Dashboard]] shows the queue. Approve → [[Executor]] runs the side effect. Reject → archived
5. **Side effects** — Emails sent (Resend), statuses updated, calendar events created, etc.

---

## Key Design Decisions

> [!tip] Why Structured Outputs?
> Every LLM call uses forced tool-use (Claude) or `responseSchema` (Gemini) — the model **must** return valid JSON matching the schema. No parsing failures, ever. See [[LLM Abstraction]].

> [!tip] Why a Single Server?
> Express serves the API, static files, WebSocket, AND runs the cron — all in one process. This keeps deployment dead simple (one `npm start`) and means the daily agent run doesn't need a separate job scheduler.

> [!tip] Why Supabase?
> Postgres + Auth + Realtime in one hosted service. The `service_role` key runs server-side (never exposed to browser). The `anon` key handles dashboard login. See [[Database Schema]].

---

## Related

- [[Tech Stack]] — Full technology list
- [[Project Structure]] — File layout
- [[Data Flow]] — How data moves end-to-end
