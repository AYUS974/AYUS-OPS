import { claudeJSON } from "./claude.js";
import { geminiJSON } from "./gemini.js";
import { groqJSON } from "./groq.js";
import { glmJSON } from "./glm.js";

const PROVIDERS = {
  anthropic: claudeJSON,
  gemini: geminiJSON,
  groq: groqJSON,
  glm: glmJSON,
};

const provider = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();

if (!PROVIDERS[provider]) {
  throw new Error(
    `Unknown LLM_PROVIDER "${provider}" — expected one of: ${Object.keys(PROVIDERS).join(", ")}`
  );
}

/**
 * Provider-agnostic structured LLM call. Every agent uses this; switch the
 * whole system between Claude and Gemini by setting LLM_PROVIDER in .env.
 *
 * @param {object} opts
 * @param {string} opts.system - role/persona for the agent
 * @param {string} opts.prompt - the task + data
 * @param {object} opts.schema - JSON Schema describing the expected output object
 * @param {number} [opts.maxTokens]
 * @returns {Promise<object>}
 */
export const llmJSON = PROVIDERS[provider];
