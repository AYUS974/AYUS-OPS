---
aliases: [Schema, Tables, DB]
tags: [database, schema]
created: 2026-07-22
---

# 🗄️ Database Schema

All data lives in **Supabase (Postgres)**. Run `supabase/schema.sql` to create everything.

---

## Core Tables

### `leads` — Inbound Sales Leads
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | uuid | auto | Primary key |
| `name` | text | — | Lead's name |
| `email` | text | — | Contact email |
| `source` | text | `'website'` | Where they came from |
| `message` | text | — | Their inquiry |
| `status` | text | `'new'` | `new → qualified → contacted → won → lost` |
| `score` | int | — | 1-10, set by [[Arjun — Sales Agent]] |
| `ai_notes` | text | — | Agent's qualification reasoning |
| `created_at` | timestamptz | `now()` | When created |

### `invoices` — Client Invoices
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | uuid | auto | Primary key |
| `client_name` | text | — | Client name |
| `client_email` | text | — | Client email |
| `amount` | numeric | — | Invoice amount |
| `currency` | text | `'INR'` | Currency code |
| `due_date` | date | — | Payment deadline |
| `status` | text | `'unpaid'` | `unpaid → paid` |
| `risk_flag` | text | null | `null → watch → high` |
| `last_reminder_at` | timestamptz | — | Last reminder timestamp |
| `created_at` | timestamptz | `now()` | When created |

### `content_items` — Content Pipeline
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | uuid | auto | Primary key |
| `title` | text | — | Content title |
| `platform` | text | `'instagram'` | `instagram / youtube / x / blog` |
| `draft` | text | — | Content body/draft |
| `status` | text | `'draft'` | `draft → reviewed → approved → published` |
| `ai_review` | jsonb | — | Hooks + improvements from [[Kabir — Marketing Agent]] |
| `created_at` | timestamptz | `now()` | When created |

### `candidates` — Job Candidates (HR)
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | uuid | auto | Primary key |
| `name` | text | — | Candidate name |
| `email` | text | — | Contact email |
| `role_applied` | text | — | Job title applied for |
| `resume_text` | text | — | Resume content (text) |
| `status` | text | `'new'` | `new → screened → interview → rejected → hired` |
| `ai_score` | int | — | 1-10, set by [[Isha — HR Agent]] |
| `ai_review` | jsonb | — | Strengths, concerns, interview questions |
| `created_at` | timestamptz | `now()` | When created |

### `project_updates` — Tech Updates (CTO)
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | uuid | auto | Primary key |
| `project` | text | — | Project name |
| `update_text` | text | — | The update description |
| `status` | text | `'new'` | `new → triaged` |
| `ai_priority` | text | — | `P0 / P1 / P2 / P3` |
| `ai_review` | jsonb | — | Recommendation + next steps |
| `created_at` | timestamptz | `now()` | When created |

---

## System Tables

### `pending_actions` — The Approval Queue ⭐
> This is the **core table** of the entire system. See [[Pending Actions]] for deep dive.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | uuid | auto | Primary key |
| `agent` | text | — | Which agent proposed this |
| `type` | text | — | Action type (see [[Executor]]) |
| `title` | text | — | Human-readable title |
| `summary` | text | — | Description of what will happen |
| `payload` | jsonb | `{}` | Action data (email body, to address, etc.) |
| `status` | text | `'pending'` | `pending → approved → rejected → executed → failed` |
| `created_at` | timestamptz | `now()` | When proposed |
| `decided_at` | timestamptz | — | When approved/rejected |
| `executed_at` | timestamptz | — | When executed |

### `agent_runs` — Audit Log
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `agent` | text | Agent name |
| `status` | text | `ok / error` |
| `items_processed` | int | How many items processed |
| `summary` | text | Run summary |
| `created_at` | timestamptz | When the run happened |

### `daily_digests` — Morning Briefings
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `digest_date` | date | Date of digest |
| `content` | text | The digest text (Hinglish) |
| `created_at` | timestamptz | When generated |

### `sent_emails` — Email Audit Log
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `to_email` | text | Recipient |
| `subject` | text | Email subject |
| `body` | text | Email body |
| `provider` | text | `resend / stub` |
| `provider_id` | text | Resend message ID |
| `agent` | text | Which agent drafted it |
| `action_id` | uuid | FK to pending_actions |
| `created_at` | timestamptz | When sent |

---

## Indexes

```sql
idx_pending_actions_status  ON pending_actions (status, created_at DESC)
idx_leads_status            ON leads (status)
idx_invoices_status         ON invoices (status, due_date)
idx_candidates_status       ON candidates (status)
idx_project_updates_status  ON project_updates (status)
idx_sent_emails_created     ON sent_emails (created_at DESC)
```

---

## Migration History

| File | What it adds |
|------|-------------|
| `schema.sql` | Core tables (leads, invoices, content, pending_actions, agent_runs, daily_digests, candidates, project_updates, sent_emails) |
| `seed.sql` | Sample data for first run |
| `upgrade-v2.sql` | HR + CTO tables |
| `upgrade-v3.sql` | Missions + Workflows |
| `upgrade-v4.sql` | Analytics + Memory |
| `upgrade-v5.sql` | Inbox + Handoffs |

---

## Related

- [[Pending Actions]] — Deep dive into the approval queue
- [[Data Flow]] — How data moves through the system
- [[Architecture Overview]]
