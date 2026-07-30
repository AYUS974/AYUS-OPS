---
aliases: [Kabir, Marketing Agent, Marketing]
tags: [agent, marketing]
created: 2026-07-22
---

# 📣 Kabir — Marketing Agent

> **File:** `src/agents/marketing.js` (2.5 KB)
> **Data source:** `content_items` table
> **Action type:** `content_review`

---

## What Kabir Does

1. **Fetches** content items with `status = 'draft'`
2. **Reviews** each piece for platform fit, hook quality, engagement potential
3. **Writes** alternative hooks and improvement suggestions
4. **Creates** `content_review` proposals in [[Pending Actions]]

---

## Content Platforms

| Platform | Examples |
|----------|----------|
| `instagram` | Reels, posts, carousels |
| `youtube` | Videos, shorts |
| `x` | Tweets, threads |
| `blog` | Articles, case studies |

---

## When Approved

The [[Executor]] handles `content_review`:
1. Updates the content item's `status` to `reviewed`
2. Stores the AI review in `ai_review` (JSONB) — hooks, suggestions, score

---

## Database Tables

- **Reads:** `content_items` (title, platform, draft, status)
- **Writes:** `content_items` (status, ai_review), `pending_actions`

---

## Related

- [[Agents Overview]]
- [[Database Schema]] — `content_items` table
