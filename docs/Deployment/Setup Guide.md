---
aliases: [Setup, Getting Started, Installation]
tags: [setup, guide]
created: 2026-07-22
---

# 🚀 Setup Guide — Get Running in 20 Minutes

---

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **A Supabase project** — [supabase.com](https://supabase.com) (free tier works)
- **An LLM API key** — at least one of: Anthropic, Gemini (free), Groq (free)

---

## Step 1: Supabase Setup (5 min)

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** → paste and run `supabase/schema.sql`
   - Safe to re-run (uses `CREATE IF NOT EXISTS`)
3. Optionally run `supabase/seed.sql` for sample data
4. **Create your login:**
   - Authentication → Users → Add user
   - Enter email + strong password
   - ✅ Tick "Auto Confirm User"
5. **Disable public signups:**
   - Authentication → Sign In / Up → disable "Allow new users to sign up"

---

## Step 2: Environment Setup (5 min)

```bash
cp .env.example .env
```

Fill in the required keys:

| Key | Where to get it | Required? |
|-----|----------------|-----------|
| `SUPABASE_URL` | Supabase → Project Settings → API | ✅ Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page | ✅ Yes |
| `SUPABASE_ANON_KEY` | Same page | ✅ Yes |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | ✅ If using Claude |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) | Free tier available |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) | Free tier, good for voice |
| `RESEND_API_KEY` | [resend.com](https://resend.com) | Optional (console stub without) |

See [[Environment Variables]] for the full list.

---

## Step 3: Install & Run (5 min)

```bash
# Install dependencies
npm install

# Build the React dashboard
npm run build

# Start (API + dashboard on :3000)
npm start
```

Open http://localhost:3000 → sign in → hit **"Run agents now"** → watch the approval queue fill up!

### Development Mode (with hot reload)

```bash
npm run dev    # Express on :3000 + Vite dev on :5173 (open :5173)
```

---

## Step 4: Desktop App (Optional)

```bash
cd desktop
npm install
npm start

# If GPU issues:
# $env:AYUS_DISABLE_GPU="1"; npm start
```

See [[Desktop App (Electron)]] for details.

---

## Step 5: Connect Services (Optional)

In the dashboard sidebar:
- **Connect Google** → Gmail + Calendar
- **Connect Spotify** → Music playback

See [[Google Integration]] and [[Spotify Integration]] for setup.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Dashboard shows "Could not start" | Check `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env` |
| Agents error "Unknown LLM_PROVIDER" | Set `LLM_PROVIDER` to `anthropic`, `gemini`, `groq`, or `glm` |
| Desktop GPU crash | Use `$env:AYUS_DISABLE_GPU="1"` |
| Desktop WebSocket error | The `ws` package polyfill is needed for Node < 22 |
| Voice not working | Check `GROQ_API_KEY` (for STT) + at least one TTS provider |
| Emails not sending | Check `RESEND_API_KEY` (leave empty for console mode) |

---

## Related

- [[Environment Variables]] — Full .env reference
- [[Render Deployment]] — Cloud deploy
- [[Docker]] — Container build
