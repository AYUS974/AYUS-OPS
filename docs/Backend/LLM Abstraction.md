---
aliases: [LLM, AI Layer, Model Router]
tags: [backend, llm, ai]
created: 2026-07-22
---

# 🧠 LLM Abstraction

> **File:** `src/lib/llm.js` (2.2 KB)
> Provider-agnostic structured LLM calls with per-task model routing.

---

## How It Works

Every agent calls `llmJSON()` — a single function that:
1. Routes to the correct LLM provider
2. Sends the prompt with a persona and JSON schema
3. Returns a **guaranteed valid JSON object** matching the schema

```javascript
const result = await llmJSON({
  system: "You are a sales rep...",
  prompt: "Here are the leads: ...",
  schema: { type: "object", properties: {...} },
  maxTokens: 2000,
});
// result is ALWAYS valid JSON matching the schema
```

---

## Providers

| Provider | Key | How JSON is Enforced |
|----------|-----|---------------------|
| **Anthropic Claude** | `ANTHROPIC_API_KEY` | Forced tool-use (the model MUST call a tool with the schema) |
| **Google Gemini** | `GEMINI_API_KEY` | `responseSchema` (native JSON mode) |
| **Groq** (Llama 3.3) | `GROQ_API_KEY` | JSON mode + schema validation |
| **GLM-4** | `GLM_API_KEY` | Tool-use pattern |

Set `LLM_PROVIDER=anthropic|gemini|groq|glm` in `.env` to switch globally.

---

## Per-Task Model Routing

> "Jaisa task, waisa model"

Some tasks need stronger models. The `tier` option routes to a different provider:

```javascript
// Mission Control code generation → use a stronger model
await llmJSON({
  system: "Write production-ready code...",
  prompt: "...",
  schema: CODE_SCHEMA,
  tier: "code",  // → routes to LLM_PROVIDER_CODE (or Groq if GROQ_API_KEY is set)
});
```

| Tier | Env Var | Default |
|------|---------|---------|
| `code` | `LLM_PROVIDER_CODE` | Groq (if key set), else global default |

You can also force a specific provider per call:
```javascript
await llmJSON({ provider: "anthropic", ... }); // ignores LLM_PROVIDER and tiers
```

---

## Why Structured Outputs?

> [!important] No Parsing Failures, Ever
> Traditional LLM APIs return free-form text that you parse with regex or hope is valid JSON. AYUS Ops uses **forced structured output** — the model literally cannot return anything that doesn't match the schema. This eliminates an entire class of production bugs.

---

## Related

- [[Tech Stack]] — Provider details
- [[Agents Overview]] — All agents use this
- [[Architecture Overview]]
