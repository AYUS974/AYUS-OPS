---
aliases: [Container, Dockerfile]
tags: [deployment, docker]
created: 2026-07-22
---

# 🐳 Docker

> **File:** `Dockerfile` (429 bytes)

Multi-stage container build for Railway, Fly.io, or your own server.

---

## Build & Run

```bash
docker build -t ayus-ops .
docker run -p 3000:3000 --env-file .env ayus-ops
```

---

## What's Inside

The Dockerfile does a multi-stage build:
1. Install dependencies
2. Build the React frontend (`npm run build`)
3. Copy only production files to final image
4. Start the server (`npm start`)

---

## Related

- [[Render Deployment]] — Managed hosting
- [[Setup Guide]]
