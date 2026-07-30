-- =====================================================
-- AYUS Ops v5 upgrade — Workflow Automation (the "n8n layer").
-- Run once in Supabase SQL Editor. Safe to re-run.
--
-- A Workflow = a TRIGGER + an ordered list of STEPS. When the trigger fires,
-- the engine runs the steps in order, threading each step's output into the
-- next as context. Steps act on the primitives AYUS already has:
--   • create_mission  → kick the autonomous org at an objective
--   • llm             → run a structured LLM call, output feeds downstream
--   • propose_action  → drop a card into the human approval queue
--   • notify          → Telegram / console ping
--   • http            → generic outbound request (the n8n escape hatch)
--   • delay           → wait N seconds
--
-- Triggers: manual (Run now) | schedule (cron) | event (webhook token).
--
--   • workflows      → definition + trigger + steps + enabled flag
--   • workflow_runs  → one row per execution, with the per-step log
--
-- owner_id on every row (multi-tenant), same server-side service-role +
-- requireAuth model as missions — no RLS added here.
-- =====================================================

create extension if not exists "pgcrypto";

-- ---------- Workflows ----------
create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,                                   -- the founder (auth.users.id)
  name text not null,
  description text,
  enabled boolean not null default true,
  trigger jsonb not null default '{"type":"manual"}'::jsonb,  -- {type, cron?, token?}
  steps jsonb not null default '[]'::jsonb,        -- [{ id, type, name, config }]
  last_run_at timestamptz,
  last_status text,                                -- ok | error | running | null
  run_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_workflows_owner on workflows (owner_id, created_at desc);
create index if not exists idx_workflows_enabled on workflows (enabled) where enabled = true;

-- ---------- Workflow runs ----------
-- status: running → ok | error. `log` is the per-step trace the UI replays.
create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  owner_id uuid,
  trigger_type text,                               -- how it fired: manual | schedule | event
  status text not null default 'running',
  log jsonb not null default '[]'::jsonb,          -- [{ step, type, status, message, ms }]
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_workflow_runs_wf on workflow_runs (workflow_id, started_at desc);
create index if not exists idx_workflow_runs_owner on workflow_runs (owner_id, started_at desc);
