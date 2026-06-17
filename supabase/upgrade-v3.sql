-- =====================================================
-- AYUS Ops v3 upgrade — run once in Supabase SQL Editor.
-- Adds:
--   • agent_memory      → agents remember & learn from your approvals/rejections
--   • oauth_tokens      → stores the Google (Gmail + Calendar) connection
--   • pending_actions.meta → lineage for inter-agent handoffs + urgency flag
-- Safe to re-run.
-- =====================================================

create extension if not exists "pgcrypto";

-- ---------- Agent memory & learning ----------
-- One row = one thing an agent should remember. agent='company' is shared by all.
create table if not exists agent_memory (
  id uuid primary key default gen_random_uuid(),
  agent text not null,                         -- sales | finance | ... | secretary | company
  kind text not null default 'note',           -- preference | fact | lesson | client_note | note
  content text not null,
  weight int not null default 1,               -- higher = surfaced first
  source_action_id uuid,                       -- the pending_action that taught this (if any)
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists idx_agent_memory_agent on agent_memory (agent, weight desc, created_at desc);

-- ---------- Google OAuth (Gmail + Calendar) ----------
-- Single-user app: one Google account, refreshed automatically server-side.
create table if not exists oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique,               -- 'google'
  account_email text,
  access_token text,
  refresh_token text,
  scope text,
  token_type text,
  expiry timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Inter-agent handoff lineage + urgency ----------
-- meta stores e.g. { "parent_action_id": "...", "via": "handoff", "from": "hr" }
alter table pending_actions add column if not exists meta jsonb not null default '{}'::jsonb;
-- urgent actions get pushed to you immediately (Telegram) and flagged in the UI
alter table pending_actions add column if not exists urgent boolean not null default false;

-- Let HR schedule interviews & finance draft invoices as first-class action types —
-- nothing to migrate, just documenting the new executor-supported types:
--   schedule_interview | draft_invoice | calendar_event | gmail_reply

-- A couple of analytics-friendly indexes
create index if not exists idx_agent_runs_created on agent_runs (created_at desc);
create index if not exists idx_leads_created on leads (created_at desc);
create index if not exists idx_invoices_created on invoices (created_at desc);
