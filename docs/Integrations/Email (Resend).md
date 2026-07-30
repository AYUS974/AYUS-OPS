---
aliases: [Resend, Email System]
tags: [integration, email]
created: 2026-07-22
---

# ✉️ Email (Resend)

> **File:** `src/lib/email.js` (2 KB)

---

## How It Works

| Mode | When | Behavior |
|------|------|----------|
| **Resend** | `RESEND_API_KEY` is set | Real email delivery |
| **Console stub** | No API key | Email printed to server console |

Both modes log every send to the `sent_emails` table for audit.

---

## Config

```env
RESEND_API_KEY=re_...
EMAIL_FROM="AYUS Labs <onboarding@resend.dev>"
```

> [!tip] Testing
> Leave `RESEND_API_KEY` empty during development. Emails will print to console and still appear in `sent_emails` — you can verify everything works before enabling real sending.

---

## Who Sends Emails

- [[Arjun — Sales Agent]] → follow-up emails to leads
- [[Meera — Finance Agent]] → payment reminder emails

---

## Related

- [[Executor]] — Calls email on approval
- [[Database Schema]] — `sent_emails` table
