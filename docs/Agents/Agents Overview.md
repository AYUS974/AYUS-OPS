---
aliases: [Agents, Agent Overview]
tags: [agent, overview, moc]
created: 2026-07-22
---

# 🤖 Agents Overview

AYUS Ops runs **7 AI agents**, each with a specific department and persona. They all follow the same pattern:

```
Fetch data from Supabase → Send to LLM with persona + JSON schema → Write proposals to pending_actions
```

> [!important] No Direct Actions
> Agents **never** execute side effects. They write structured proposals to the [[Pending Actions]] table. Only the [[Executor]] runs real actions — after your approval.

---

## Agent Roster

| Agent | Name | Department | Data Source | Action Types |
|-------|------|-----------|-------------|--------------|
| 🧑‍💼 | [[Arjun — Sales Agent\|Arjun]] | Sales | `leads` | `send_followup` |
| 💰 | [[Meera — Finance Agent\|Meera]] | Finance | `invoices` | `send_reminder`, `draft_invoice` |
| 📣 | [[Kabir — Marketing Agent\|Kabir]] | Marketing | `content_items` | `content_review` |
| 🧑‍🎓 | [[Isha — HR Agent\|Isha]] | HR | `candidates` | `candidate_review`, `schedule_interview` |
| 👨‍💻 | [[Vikram — CTO Agent\|Vikram]] | CTO/Tech | `project_updates` | `tech_review` |
| 🤖 | [[AYUS — Secretary Agent\|AYUS]] | Secretary | Chat + all tables | `manual_task`, `gmail_send`, `calendar_event` |
| 🔍 | [[Researcher Agent]] | Research | Web search | Research summaries |

---

## The Agent Pattern

Every agent follows this exact pattern (copy `sales.js` to start a new one):

```javascript
// 1. Define the JSON schema for the LLM output
const SCHEMA = {
  type: "object",
  properties: { ... },
  required: [...]
};

// 2. Fetch relevant data from Supabase
const { data: items } = await db.from("table").select("*").eq("status", "new");

// 3. Call the LLM with a persona + schema
const result = await llmJSON({
  system: "You are [persona]. Your job is...",
  prompt: `Here are the items: ${JSON.stringify(items)}`,
  schema: SCHEMA,
  maxTokens: 2000,
});

// 4. Write proposals to pending_actions
for (const action of result.actions) {
  await db.from("pending_actions").insert({
    agent: "agent_name",
    type: action.type,
    title: action.title,
    summary: action.summary,
    payload: action.payload,
  });
}

// 5. Return stats
return { processed: items.length, summary: "..." };
```

---

## How to Add a New Agent

1. Create `src/agents/yourAgent.js` — copy `sales.js` as template
2. Define your JSON schema → fetch rows → `llmJSON()` with persona + schema → insert into `pending_actions`
3. Register in the `AGENTS` array in [[Orchestrator]] (`src/orchestrator.js`)
4. If new action type, handle it in [[Executor]] (`src/lib/executor.js`)
5. That's it — dashboard, digest, and audit log pick it up automatically

---

## Daily Run Flow

The [[Orchestrator]] runs all agents:
1. **Parallel execution** — all agents run simultaneously via `Promise.all()`
2. **Error isolation** — one agent failing doesn't stop others
3. **Logging** — every run logged to `agent_runs` table (ok/error + summary)
4. **Digest** — after all agents finish, a digest is generated in Hinglish and saved to `daily_digests`
5. **Notification** — digest pushed to Telegram (if configured)

---

## Related

- [[Orchestrator]] — The runner
- [[LLM Abstraction]] — How LLM calls work
- [[Pending Actions]] — The approval queue
- [[Executor]] — What happens on approve
