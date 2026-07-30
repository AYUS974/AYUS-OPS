---
aliases: [Render, Cloud Deploy]
tags: [deployment, render]
created: 2026-07-22
---

# ☁️ Render Deployment

> **File:** `render.yaml`

One-click deploy to Render.com.

---

## Steps

1. Push repo to GitHub
2. [Render](https://render.com) → New → Blueprint → pick the repo
3. Fill in the env vars it asks for (same as your `.env`)
4. Done!

---

## What Deploys

- **Type:** Web service (long-running, not serverless)
- **Build:** `npm install && npm run build`
- **Start:** `npm start`
- **Health check:** `GET /healthz`

> [!note] Free Tier
> Render's free tier sleeps on idle, which pauses the daily cron. For reliable 9 AM runs, use the cheapest paid instance — or stay free and just hit "Run agents now" manually.

---

## Related

- [[Docker]] — Alternative deploy
- [[Setup Guide]]
