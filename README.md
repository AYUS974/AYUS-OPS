# AYUS Ops

An AI-run operations system for AYUS Labs. Agents handle sales, finance and marketing on live Supabase data — every action they want to take lands in an approval queue, and nothing executes until you approve it from the dashboard.

```
React dashboard (you, behind Supabase Auth)
        │
Node/Express API ──► Orchestrator (daily cron)
                        │       │        │
                      Sales  Finance  Marketing   ← each one: fetch data → LLM (structured output) → propose action
                        │       │        │
                            Supabase (single source of truth)
                                │
                     Approved emails → Resend (logged to sent_emails)
```

**Stack:** React (Vite) · Node 20+/Express · Supabase (Postgres + Auth) · Anthropic API (forced tool-use, so agent output is always valid JSON) · Resend for email.

## Setup (20 minutes)

**1. Supabase**
- Create a project at supabase.com
- SQL Editor → paste and run `supabase/schema.sql` (safe to re-run — it only creates what's missing)
- (Recommended for the first run) also run `supabase/seed.sql` for sample leads, invoices and a content draft
- **Create your login:** Authentication → Users → *Add user* → enter your email + a strong password and tick *Auto Confirm User*. While you're there, turn off public signups (Authentication → Sign In / Up → disable "Allow new users to sign up") so only you can log in.

**2. Keys**
```bash
cp .env.example .env
```
Fill in:
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` — Supabase → Project Settings → API
- `ANTHROPIC_API_KEY` — console.anthropic.com
- `RESEND_API_KEY` — optional; leave empty and approved emails print to the server console instead of sending (still logged to `sent_emails`)

**3. Run**
```bash
npm install
npm run build     # builds the React dashboard into web/dist
npm start         # serves API + dashboard on :3000
```
Open http://localhost:3000, sign in with the user you created, hit **Run agents now**, and watch the approval queue fill up.

For development with hot reload:
```bash
npm run dev       # Express on :3000 + Vite dev server on :5173 (open :5173)
```

## The company

| Seat | Agent | Job |
|---|---|---|
| ★ CEO | **You** | Final approval on everything |
| Sales | **Arjun** | Qualifies `leads`, drafts follow-up emails |
| Finance | **Meera** | Chases unpaid `invoices`, flags payment risk |
| Marketing | **Kabir** | Reviews `content_items`, writes hooks |
| HR | **Isha** | Screens `candidates`, drafts interview questions |
| CTO | **Vikram** | Triages `project_updates` (bugs/ideas) by priority |
| Secretary | **AYUS** | Your JARVIS-style operations intelligence — see below |

> Upgrading from v1/v2? Run `supabase/upgrade-v2.sql` in the SQL Editor to add the HR/CTO tables.

### AYUS — the JARVIS-style assistant with (guarded) laptop access

Open the **AYUS** page (top of the sidebar) to talk to it — by **typing or voice** (mic button; it understands Hinglish too). Composed, precise, always on. It has real tools:

- Open apps (Spotify, Chrome, VS Code…), play music (`"play some Arijit Singh on Spotify"`), open websites
- Search, read and open files — **only inside `PC_ALLOWED_DIRS`** (configure in `.env`)
- Draft emails/reminders/to-dos as proposals for your approval queue

**It cannot delete, modify, move or install anything** — those tools simply don't exist in its toolkit. Anything like that becomes an approval item you decide on. All agents speak with free browser voices; add `ELEVENLABS_API_KEY` to `.env` for ultra-realistic voices (set `ELEVENLABS_VOICE_AYUS` for the AYUS voice).

## How it works

- **Agents never act directly.** They write proposals into the `pending_actions` table. The dashboard shows them; approving executes them via `src/lib/executor.js`.
- **Structured outputs.** Every model call goes through `src/lib/llm.js`, which enforces a JSON schema on the output (Anthropic via forced tool-use, Gemini via responseSchema) — no parsing failures, ever. Transient API errors retry automatically.
- **Swappable LLM provider.** Set `LLM_PROVIDER=anthropic` (default) or `LLM_PROVIDER=gemini` in `.env`. Gemini has a free tier (key from aistudio.google.com), handy for testing; Anthropic Sonnet is the recommended default for output quality.
- **The orchestrator** (`src/orchestrator.js`) runs all agents in parallel daily (`DAILY_CRON` in `.env`), logs each run to `agent_runs`, and writes a morning digest to `daily_digests`. Agents skip items that already have a proposal waiting, so re-runs never create duplicates.
- **Auth.** The dashboard logs in via Supabase Auth; every API call is verified server-side (`src/lib/auth.js`). The service-role key never leaves the server.
- **Email** goes through Resend when `RESEND_API_KEY` is set (console stub otherwise), and every send is recorded in `sent_emails`.

## Deploying (Render)

The repo ships with `render.yaml`:

1. Push the repo to GitHub
2. Render → New → Blueprint → pick the repo
3. Fill in the env vars it asks for (same values as your `.env`)

It deploys as one long-running service: Express serves both the API and the built React app, with the daily cron inside the process and a health check on `/healthz`. A `Dockerfile` is also included if you prefer Railway, Fly.io or your own server.

> Note: Render's free tier sleeps on idle, which would also pause the daily cron. For reliable 9 AM runs use the cheapest paid instance, or keep free and just hit "Run agents now" when you open the dashboard.

## Feeding it real data

The agents read from Supabase, so anything that writes to these tables feeds the system:
- `leads` — point your website contact form at a small endpoint (or Supabase's auto-generated REST API) that inserts a row
- `invoices` — insert when you raise an invoice; later this can sync from Razorpay webhooks
- `content_items` — insert drafts you want reviewed

## Adding a new agent (the pattern)

1. Create `src/agents/yourAgent.js` — copy `sales.js` as a template:
   define a JSON schema → fetch rows → `llmJSON()` with a clear persona + the schema → insert into `pending_actions` → return `{ processed, summary }`
2. Register it in the `AGENTS` array in `src/orchestrator.js`
3. If it introduces a new action type, handle it in `src/lib/executor.js`

That's it — the dashboard, digest and audit log pick it up automatically.

## Project layout

```
src/                 Node backend
  index.js           Express app: auth'd API, cron, serves web/dist
  orchestrator.js    runs all agents + writes the daily digest
  agents/            sales, finance, marketing
  lib/               anthropic (structured outputs), supabase, auth, email, executor
web/                 React (Vite) dashboard
supabase/            schema.sql + seed.sql
Dockerfile           container build (multi-stage)
render.yaml          one-click Render blueprint
```

## Roadmap ideas

- Razorpay webhook → auto-mark invoices paid
- WhatsApp/Telegram notification when the daily digest is ready
- HR agent (resume screening) — reuse the Beram assessment criteria
- Auto-approve rules for low-risk actions (e.g. reminders under X days overdue)
- History view in the dashboard (executed/rejected actions, sent_emails)
