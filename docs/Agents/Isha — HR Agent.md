---
aliases: [Isha, HR Agent, HR]
tags: [agent, hr]
created: 2026-07-22
---

# 🧑‍🎓 Isha — HR Agent

> **File:** `src/agents/hr.js` (2.7 KB)
> **Data source:** `candidates` table
> **Action types:** `candidate_review`, `schedule_interview`

---

## What Isha Does

1. **Fetches** candidates with `status = 'new'`
2. **Screens** resume text, evaluates fit for the role
3. **Scores** each candidate 1-10
4. **Generates** interview questions tailored to the candidate
5. **Creates** proposals: `candidate_review` + `schedule_interview` (for strong candidates)

---

## Screening Output

The AI review includes:
- **Score** (1-10) — overall fit
- **Strengths** — what stands out
- **Concerns** — red flags or gaps
- **Interview questions** — tailored to their background

---

## When Approved

**`candidate_review`:** Updates candidate's `status` to `screened`, saves `ai_score` and `ai_review`

**`schedule_interview`:**
1. Updates candidate status to `interview`
2. If [[Google Integration]] is connected → creates a 30-min calendar event for tomorrow 11 AM
3. Invites the candidate by email (if email provided)

---

## Database Tables

- **Reads:** `candidates` (name, email, role_applied, resume_text)
- **Writes:** `candidates` (status, ai_score, ai_review), `pending_actions`

---

## Related

- [[Agents Overview]]
- [[Database Schema]] — `candidates` table
- [[Google Integration]] — Calendar events
