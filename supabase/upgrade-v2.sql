-- =====================================================
-- AYUS Ops v2 upgrade — run once in Supabase SQL Editor.
-- Adds the HR agent (candidates) and CTO agent (project_updates) tables,
-- plus sample rows so the new agents have something to do on first run.
-- Safe to re-run.
-- =====================================================

create table if not exists candidates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  role_applied text not null,
  resume_text text,
  status text not null default 'new',         -- new | screened | interview | rejected | hired
  ai_score int,
  ai_review jsonb,
  created_at timestamptz not null default now()
);

create table if not exists project_updates (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  update_text text not null,
  status text not null default 'new',          -- new | triaged
  ai_priority text,                            -- P0 | P1 | P2 | P3
  ai_review jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_candidates_status on candidates (status);
create index if not exists idx_project_updates_status on project_updates (status);

-- Sample data (only inserts if the tables are empty)
insert into candidates (name, email, role_applied, resume_text)
select 'Sneha Kulkarni', 'sneha@example.com', 'Frontend Developer (React)',
  '3 years experience building React dashboards at a fintech startup. Shipped a design system used by 4 teams. Comfortable with TypeScript, Vite, Tailwind. Looking for a builder-culture team.'
where not exists (select 1 from candidates);

insert into candidates (name, email, role_applied, resume_text)
select 'Aman Verma', 'aman@example.com', 'Frontend Developer (React)',
  'Fresher, completed a 6-month bootcamp. Built two todo apps and a weather app with React. Eager to learn.'
where (select count(*) from candidates) < 2;

insert into project_updates (project, update_text)
select 'UTMS Native App', 'Push notifications fail on Android 14 devices — users report missing trip alerts. Affects roughly 30% of active users. Crash logs point to the FCM token refresh flow.'
where not exists (select 1 from project_updates);

insert into project_updates (project, update_text)
select 'AYUS Ops', 'Idea: add a WhatsApp notification when the daily digest is ready, so the founder sees it without opening the dashboard.'
where (select count(*) from project_updates) < 2;
