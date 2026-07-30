---
aliases: [Telegram, Notifications, Push]
tags: [integration, telegram]
created: 2026-07-22
---

# 📱 Telegram Notifications

> **File:** `src/lib/notify.js` (1.9 KB)

---

## Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot`
2. Copy the bot token
3. Message your new bot once (so it has your chat ID)
4. Get your chat ID: `https://api.telegram.org/bot<token>/getUpdates`
5. Set in `.env`:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

---

## What Gets Notified

- **Daily digest** — morning briefing after all agents run
- **Handoff alerts** — when agents delegate tasks to each other

Without Telegram configured, these just print to the server console.

---

## Related

- [[Orchestrator]] — Sends the daily digest
- [[Environment Variables]]
