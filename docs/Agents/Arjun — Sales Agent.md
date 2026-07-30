---
aliases: [Arjun, Sales Agent, Sales]
tags: [agent, sales]
created: 2026-07-22
---

# 🧑‍💼 Arjun — Sales Agent

> **File:** `src/agents/sales.js` (2.9 KB)
> **Data source:** `leads` table
> **Action type:** `send_followup`

---

## What Arjun Does

1. **Fetches** all leads with `status = 'new'` that don't already have a pending proposal
2. **Sends** each lead's data to the LLM with a sales persona
3. **Gets back** a structured response: qualification score (1-10), reasoning, and a draft follow-up email
4. **Updates** the lead's `score` and `ai_notes` in Supabase
5. **Creates** a `send_followup` proposal in [[Pending Actions]] with the email draft

---

## LLM Persona

Arjun is instructed as a sharp B2B sales rep for AYUS Labs who:
- Scores leads 1-10 on quality
- Writes professional but warm follow-up emails
- Identifies the lead's intent and fit

---

## When Approved

The [[Executor]] handles `send_followup`:
1. Sends the email via [[Email (Resend)]]
2. Updates the lead's status to `contacted`

---

## Database Tables

- **Reads:** `leads` (status, name, email, message, source)
- **Writes:** `leads` (score, ai_notes), `pending_actions`

---

## Related

- [[Agents Overview]] — All agents
- [[Database Schema]] — `leads` table structure
- [[Pending Actions]]
