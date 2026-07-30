---
aliases: [Meera, Finance Agent, Finance]
tags: [agent, finance]
created: 2026-07-22
---

# 💰 Meera — Finance Agent

> **File:** `src/agents/finance.js` (3.6 KB)
> **Data source:** `invoices` table
> **Action types:** `send_reminder`, `draft_invoice`

---

## What Meera Does

1. **Fetches** all invoices with `status = 'unpaid'`
2. **Analyzes** overdue amounts, days past due, payment history
3. **Flags risk** — marks invoices as `watch` or `high` risk
4. **Drafts** payment reminder emails for overdue invoices
5. **Creates** `send_reminder` proposals in [[Pending Actions]]

---

## Risk Flagging

| Flag | Meaning |
|------|---------|
| `null` | On time or recently issued |
| `watch` | Approaching due date, soft nudge needed |
| `high` | Significantly overdue, escalation recommended |

---

## When Approved

The [[Executor]] handles `send_reminder`:
1. Sends the reminder email via [[Email (Resend)]]
2. Updates `last_reminder_at` on the invoice

For `draft_invoice`:
1. Creates a new row in the `invoices` table

---

## Database Tables

- **Reads:** `invoices` (client_name, amount, due_date, status, last_reminder_at)
- **Writes:** `invoices` (risk_flag, last_reminder_at), `pending_actions`

---

## Related

- [[Agents Overview]]
- [[Database Schema]] — `invoices` table
