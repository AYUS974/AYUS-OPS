import { anthropicJSON } from "./anthropic.js";
import { geminiJSON } from "./gemini.js";
import { groqJSON } from "./groq.js";
import { glmJSON } from "./glm.js";

const PROVIDERS = {
  anthropic: anthropicJSON,
  gemini: geminiJSON,
  groq: groqJSON,
  glm: glmJSON,
};

const DEFAULT = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();

if (!PROVIDERS[DEFAULT]) {
  throw new Error(
    `Unknown LLM_PROVIDER "${DEFAULT}" — expected one of: ${Object.keys(PROVIDERS).join(", ")}`
  );
}

/**
 * Per-task model routing — "jaisa task, waisa model". Some work is heavier than a
 * chat turn: writing real, runnable code needs a stronger / higher-output-limit
 * model than the cheap default that handles scoping and prose. A call can opt into
 * a tier and we route it to that tier's provider, falling back to the global
 * default when the tier isn't configured.
 *
 * The "code" tier (used by the Mission engine's builder) defaults to Groq when a
 * GROQ_API_KEY is present — llama-3.3-70b is far better at code than glm-4-flash
 * and doesn't truncate at 4k output tokens. Override per tier via env, e.g.
 * LLM_PROVIDER=glm with LLM_PROVIDER_CODE=groq (or anthropic for top quality).
 */
const TIER_PROVIDER = {
  code: (
    process.env.LLM_PROVIDER_CODE || (process.env.GROQ_API_KEY ? "groq" : DEFAULT)
  ).toLowerCase(),
};

/**
 * Provider-agnostic structured LLM call. Every agent uses this; switch the whole
 * system between providers with LLM_PROVIDER, or route a single call elsewhere
 * with `tier` (configured) or `provider` (explicit, wins over everything).
 *
 * @param {object} opts
 * @param {string} opts.system - role/persona for the agent
 * @param {string} opts.prompt - the task + data
 * @param {object} opts.schema - JSON Schema describing the expected output object
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.tier] - logical tier, e.g. "code" → LLM_PROVIDER_CODE
 * @param {string} [opts.provider] - force a specific provider id, bypassing tiers
 * @returns {Promise<object>}
 */
export function llmJSON({ provider, tier, ...opts }) {
  const name = (provider || (tier && TIER_PROVIDER[tier]) || DEFAULT).toLowerCase();
  const fn = PROVIDERS[name] || PROVIDERS[DEFAULT];
  return fn(opts);
}
