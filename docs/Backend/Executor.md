---
aliases: [Action Executor, Side Effects]
tags: [backend, executor]
created: 2026-07-22
---

# ⚡ Executor

> **File:** `src/lib/executor.js` (4.4 KB)
> The only place side effects happen.

---

## What It Does

When you **approve** an action from the [[Dashboard]], the executor runs the real-world side effect. This is the **only code path** that sends emails, updates records, or creates calendar events.

---

## Action Types Handled

| Action Type | What Happens |
|-------------|-------------|
| `send_followup` | Send email via [[Email (Resend)]] + mark lead as `contacted` |
| `send_reminder` | Send reminder email + update `last_reminder_at` on invoice |
| `content_review` | Update content to `reviewed` + save AI review |
| `manual_task` | No-op (just marks as executed) |
| `schedule_interview` | Move candidate to `interview` + create Calendar event (if Google connected) |
| `draft_invoice` | Create new invoice row in Supabase |
| `calendar_event` | Create Google Calendar event |
| `gmail_reply` | Reply via Gmail API |
| `gmail_send` | Send via Gmail API |
| `candidate_review` | Update candidate to `screened` + save score/review |
| `tech_review` | Update project_update to `triaged` + save priority/review |

---

## Error Handling

If execution fails, the action status becomes `failed` (not `executed`). The error is logged and the dashboard shows it.

---

## Related

- [[Pending Actions]] — Source of actions
- [[Dashboard]] — Where approval happens
- [[Email (Resend)]]
- [[Google Integration]]
