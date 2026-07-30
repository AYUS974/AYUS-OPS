---
aliases: [Cron, Agent Runner]
tags: [backend, orchestrator]
created: 2026-07-22
---

# 🎯 Orchestrator

> **File:** `src/orchestrator.js` (3.3 KB)

The orchestrator runs all agents in parallel and generates the daily digest.

---

## Registered Agents

```javascript
const AGENTS = [
  ["sales",     runSalesAgent],      // Arjun
  ["finance",   runFinanceAgent],    // Meera
  ["marketing", runMarketingAgent],  // Kabir
  ["secretary", runSecretaryAgent],  // AYUS
  ["hr",        runHrAgent],         // Isha
  ["cto",       runCtoAgent],        // Vikram
];
```

---

## How It Runs

1. **Parallel execution** — `Promise.all()` runs all agents simultaneously
2. **Error isolation** — `runOne()` wraps each agent in try/catch. One failure doesn't stop others
3. **Audit logging** — Every run (success or error) is recorded in `agent_runs`
4. **Digest generation** — After all agents finish:
   - Counts pending actions awaiting approval
   - Sends results to LLM with a "chief-of-staff" persona
   - Gets a crisp daily digest in **Hinglish** (casual Hindi-English)
   - Saves to `daily_digests` table
   - Pushes to [[Telegram Notifications]] (if configured)

---

## Triggers

| Trigger | How |
|---------|-----|
| **Daily cron** | `node-cron` at `DAILY_CRON` (default `0 9 * * *` = 9 AM) |
| **Manual** | "Run agents now" button in [[Dashboard]] → `POST /api/run-agents` |
| **CLI** | `npm run run-agents` |

---

## Related

- [[Agents Overview]] — All agent details
- [[Server (index.js)]] — Where the cron is set up
