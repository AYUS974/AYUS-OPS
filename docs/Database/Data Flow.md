---
aliases: [Data Movement, Flow]
tags: [database, architecture]
created: 2026-07-22
---

# 🔄 Data Flow

How data enters, gets processed, and produces outcomes in AYUS Ops.

---

## Entry Points

| Source | Table | How |
|--------|-------|-----|
| Website contact form | `leads` | Direct Supabase insert or API |
| Manual entry (dashboard) | Any table | Dashboard forms |
| Invoice creation | `invoices` | Manual or Razorpay webhook (future) |
| Content drafts | `content_items` | Manual insert |
| Job applications | `candidates` | Manual insert |
| Bug reports / ideas | `project_updates` | Manual insert |
| Gmail inbox | `pending_actions` | [[Google Integration]] auto-processes |

---

## Processing Flow

```
                    ┌──────────────────┐
  External Input →  │  Supabase Table  │
                    │  (leads, etc.)   │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   Agent (daily)   │
                    │  fetch + analyze  │
                    │  via LLM + schema │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ pending_actions   │
                    │ (status: pending) │
                    └────────┬─────────┘
                             │
                      ┌──────▼──────┐
                      │  Dashboard  │
                      │  You decide │
                      └──┬──────┬───┘
                    Approve   Reject
                         │        │
                ┌────────▼──┐  ┌──▼────────┐
                │  Executor  │  │ archived  │
                │ side effect│  │ (no-op)   │
                └────────┬───┘  └───────────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         Send Email  Update DB  Calendar
         (Resend)    (status)   (Google)
```

---

## Output Channels

| Channel | When | Config |
|---------|------|--------|
| **Email** (Resend) | Approved follow-ups/reminders | `RESEND_API_KEY` |
| **Gmail** | AYUS-drafted emails | [[Google Integration]] |
| **Google Calendar** | Interview scheduling | [[Google Integration]] |
| **Telegram** | Daily digest notification | `TELEGRAM_BOT_TOKEN` |
| **Console** | Fallback for everything above | Always on |

---

## Related

- [[Architecture Overview]]
- [[Database Schema]]
- [[Pending Actions]]
- [[Executor]]
