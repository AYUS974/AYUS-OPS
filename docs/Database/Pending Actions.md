---
aliases: [Approval Queue, Actions Queue]
tags: [database, core]
created: 2026-07-22
---

# ⭐ Pending Actions — The Approval Queue

> **Table:** `pending_actions`
> **This is the single most important table in the system.**

---

## How It Works

```
Agent proposes → Row inserted (status: pending)
    ↓
Dashboard shows it → You review
    ↓
Approve → Executor runs side effect → status: executed
Reject  → status: rejected (no side effect)
```

---

## Action Types

| Type | Agent | Side Effect |
|------|-------|-------------|
| `send_followup` | Sales (Arjun) | Sends follow-up email, marks lead as contacted |
| `send_reminder` | Finance (Meera) | Sends payment reminder, updates last_reminder_at |
| `content_review` | Marketing (Kabir) | Updates content status to reviewed + saves AI review |
| `candidate_review` | HR (Isha) | Updates candidate to screened + saves score/review |
| `schedule_interview` | HR (Isha) | Updates candidate to interview + creates Calendar event |
| `tech_review` | CTO (Vikram) | Marks update as triaged + saves priority/review |
| `manual_task` | Secretary (AYUS) | No side effect — just marks as done |
| `draft_invoice` | Finance (Meera) | Creates new invoice row |
| `gmail_send` | Secretary (AYUS) | Sends via Gmail API |
| `gmail_reply` | Secretary (AYUS) | Replies via Gmail API |
| `calendar_event` | Secretary (AYUS) | Creates Google Calendar event |

---

## Status Flow

```
pending → approved → executed
                   → failed (executor error)
        → rejected
```

---

## Duplicate Prevention

Agents skip items that already have a `pending` proposal in the queue. This means re-running agents never creates duplicate proposals.

---

## Related

- [[Database Schema]] — Full table structure
- [[Executor]] — What runs on approval
- [[Dashboard]] — Where you approve/reject
