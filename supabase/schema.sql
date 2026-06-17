-- =====================================================
-- AYUS Ops — core schema
-- Run this once in Supabase SQL Editor.
-- =====================================================

create extension if not exists "pgcrypto";

-- Inbound leads (website form, DMs, referrals)
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  source text default 'website',
  message text,
  status text not null default 'new',        -- new | qualified | contacted | won | lost
  score int,                                  -- 1-10, set by sales agent
  ai_notes text,                              -- agent's qualification reasoning
  created_at timestamptz not null default now()
);

-- Client invoices
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  client_name text not null,
  client_email text,
  amount numeric not null,
  currency text not null default 'INR',
  due_date date not null,
  status text not null default 'unpaid',     -- unpaid | paid
  risk_flag text,                             -- null | watch | high
  last_reminder_at timestamptz,
  created_at timestamptz not null default now()
);

-- Content pipeline (reels, posts, blogs)
create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  platform text default 'instagram',         -- instagram | youtube | x | blog
  draft text,
  status text not null default 'draft',      -- draft | reviewed | approved | published
  ai_review jsonb,                            -- hooks + improvement notes from marketing agent
  created_at timestamptz not null default now()
);

-- THE CORE TABLE: every action an agent wants to take lands here first.
-- Nothing executes until you approve it from the dashboard.
create table if not exists pending_actions (
  id uuid primary key default gen_random_uuid(),
  agent text not null,                        -- sales | finance | marketing | orchestrator
  type text not null,                         -- send_followup | send_reminder | content_review
  title text not null,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',    -- pending | approved | rejected | executed | failed
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  executed_at timestamptz
);

-- Audit log of every agent run
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent text not null,
  status text not null,                       -- ok | error
  items_processed int default 0,
  summary text,
  created_at timestamptz not null default now()
);

-- One digest per orchestrator run — your morning briefing
create table if not exists daily_digests (
  id uuid primary key default gen_random_uuid(),
  digest_date date not null default current_date,
  content text not null,
  created_at timestamptz not null default now()
);

-- Job candidates for the HR agent (drop resume text in, get screening out)
create table if not exists candidates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  role_applied text not null,
  resume_text text,
  status text not null default 'new',         -- new | screened | interview | rejected | hired
  ai_score int,                                -- 1-10, set by HR agent
  ai_review jsonb,                             -- strengths, concerns, interview questions
  created_at timestamptz not null default now()
);

-- Project/tech updates for the CTO agent to triage
create table if not exists project_updates (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  update_text text not null,
  status text not null default 'new',          -- new | triaged
  ai_priority text,                            -- P0 | P1 | P2 | P3
  ai_review jsonb,                             -- recommendation + next steps
  created_at timestamptz not null default now()
);

create index if not exists idx_candidates_status on candidates (status);
create index if not exists idx_project_updates_status on project_updates (status);

-- Audit log of every email sent (Resend or console stub)
create table if not exists sent_emails (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  subject text not null,
  body text,
  provider text not null default 'stub',      -- resend | stub
  provider_id text,                            -- Resend message id, if any
  agent text,                                  -- which agent drafted it
  action_id uuid,                              -- the pending_actions row it came from
  created_at timestamptz not null default now()
);

create index if not exists idx_pending_actions_status on pending_actions (status, created_at desc);
create index if not exists idx_leads_status on leads (status);
create index if not exists idx_invoices_status on invoices (status, due_date);
create index if not exists idx_sent_emails_created on sent_emails (created_at desc);
