---
aliases: [Vikram, CTO Agent, CTO, Tech]
tags: [agent, cto]
created: 2026-07-22
---

# 👨‍💻 Vikram — CTO Agent

> **File:** `src/agents/cto.js` (2.6 KB)
> **Data source:** `project_updates` table
> **Action type:** `tech_review`

---

## What Vikram Does

1. **Fetches** project updates with `status = 'new'`
2. **Triages** each update — bug? feature request? idea? performance issue?
3. **Assigns priority** (P0-P3) based on severity and impact
4. **Recommends** next steps and assigns to the right area
5. **Creates** `tech_review` proposals in [[Pending Actions]]

---

## Priority Levels

| Priority | Meaning | Example |
|----------|---------|---------|
| **P0** | Critical — fix immediately | Production down, data loss |
| **P1** | High — fix this sprint | Major bug, security issue |
| **P2** | Medium — plan for it | Feature request, tech debt |
| **P3** | Low — backlog | Nice-to-have, cosmetic |

---

## When Approved

The [[Executor]] handles `tech_review`:
1. Updates the project update's `status` to `triaged`
2. Saves `ai_priority` and `ai_review` (recommendation + next steps)

---

## Database Tables

- **Reads:** `project_updates` (project, update_text, status)
- **Writes:** `project_updates` (status, ai_priority, ai_review), `pending_actions`

---

## Related

- [[Agents Overview]]
- [[Database Schema]] — `project_updates` table
