-- =====================================================
-- AYUS Ops v4 upgrade — the Mission Engine.
-- Run once in Supabase SQL Editor. Safe to re-run.
--
-- Adds the autonomous-org layer on top of the existing fan-out agents:
-- a single founder objective ("Mission") is scoped by the CEO, decomposed by
-- the Planner, executed by specialists (passing artifacts agent-to-agent),
-- assembled, then graded by QA and a senior Reviewer before delivery.
--
--   • missions        → one high-level objective + its lifecycle + final result
--   • mission_tasks   → the decomposed work, assigned to specialist roles, with deps
--   • mission_events  → the A2A message bus + audit log (who said what, to whom)
--
-- owner_id is carried on every row so this is multi-tenant from day one.
-- (Data access is server-side via the service-role client + requireAuth, the
--  same model the rest of AYUS Ops uses, so we don't add RLS here.)
-- =====================================================

create extension if not exists "pgcrypto";

-- ---------- Missions ----------
-- status state-machine:
--   queued → planning → running → assembling → reviewing → revising
--          → completed | failed
create table if not exists missions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,                                  -- the founder (auth.users.id); null = legacy/system
  objective text not null,                        -- the founder's high-level ask
  status text not null default 'queued',
  stage text,                                     -- human label of the current step, for the UI
  deliverable_type text,                          -- ceo's read: research_report | linkedin_post | email | plan | code | ...
  plan jsonb not null default '{}'::jsonb,         -- ceo scope + success criteria
  result jsonb,                                   -- { title, deliverable, debrief, qa, review }
  quality_score int,                              -- final QA score 1-10
  error text,                                     -- set if status = failed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_missions_owner on missions (owner_id, created_at desc);
create index if not exists idx_missions_status on missions (status, created_at desc);

-- ---------- Mission tasks ----------
-- The planner writes these. key is a stable slug ("t1") so deps can reference it.
create table if not exists mission_tasks (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references missions(id) on delete cascade,
  owner_id uuid,
  task_key text not null,                         -- "t1", "t2" — referenced by depends_on
  title text not null,
  description text,                               -- what this specialist must produce
  role text not null,                             -- specialist role id (see src/lib/missions/roles.js)
  depends_on text[] not null default '{}',        -- task_keys that must finish first
  position int not null default 0,                -- execution/display order
  status text not null default 'pending',         -- pending | running | done | failed | skipped
  output text,                                    -- the work product (markdown)
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_mission_tasks_mission on mission_tasks (mission_id, position);

-- ---------- Mission events (A2A bus + audit log) ----------
-- Every message between agents, every status change, every artifact handoff
-- lands here. This is what makes the org legible — the timeline you can replay.
create table if not exists mission_events (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null references missions(id) on delete cascade,
  owner_id uuid,
  kind text not null default 'message',           -- message | status | artifact | error | delegation
  from_agent text,                                -- role id, or 'founder' / 'system'
  to_agent text,                                  -- role id, or 'founder' / 'all'
  message text,                                   -- human-readable line for the timeline
  data jsonb not null default '{}'::jsonb,         -- structured payload (scores, task_key, etc.)
  created_at timestamptz not null default now()
);
create index if not exists idx_mission_events_mission on mission_events (mission_id, created_at);
