---
aliases: [Google, Gmail, Calendar]
tags: [integration, google]
created: 2026-07-22
---

# 📧 Google Integration — Gmail + Calendar

> **File:** `src/lib/google.js` (9.7 KB)

---

## Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Enable **Gmail API** + **Google Calendar API**
3. OAuth consent screen → External → add yourself as test user
4. Credentials → OAuth client ID (Web application)
5. Add redirect URI: `http://localhost:3000/api/google/callback`
6. Copy Client ID & Secret to `.env`:

```env
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
```

7. In the dashboard sidebar → click **"Connect Google"**

---

## Capabilities

### Gmail
| Function | Description |
|----------|-------------|
| **Read inbox** | Process and summarize emails |
| **Send email** | Send new emails via Gmail |
| **Reply** | Reply to existing threads |

### Calendar
| Function | Description |
|----------|-------------|
| **Create events** | Schedule meetings, interviews |
| **Auto-schedule** | HR agent creates interview slots |

---

## How It's Used

- [[Isha — HR Agent]] → creates interview calendar events on approval
- [[AYUS — Secretary Agent]] → sends Gmail, creates calendar events via chat
- [[Executor]] → handles `gmail_send`, `gmail_reply`, `calendar_event` action types

---

## Related

- [[Environment Variables]] — Google config keys
- [[Executor]] — Handles Google actions
