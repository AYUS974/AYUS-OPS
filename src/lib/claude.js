import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// Lazy so the app can boot in Gemini-only mode without an Anthropic key.
// The SDK retries transient failures (429, 5xx, network) with backoff automatically.
let client;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 3 });
  }
  return client;
}

/**
 * Call Claude and get back structured JSON, guaranteed valid.
 *
 * Instead of asking the model to "respond with JSON" and parsing text (which
 * breaks whenever it adds prose or fences), we hand it a single tool whose
 * input schema is the shape we want and force it to call that tool. The API
 * then guarantees the result conforms to the schema.
 *
 * Every agent goes through this one function, so reliability fixes live in one place.
 *
 * @param {object} opts
 * @param {string} opts.system - role/persona for the agent
 * @param {string} opts.prompt - the task + data
 * @param {object} opts.schema - JSON Schema describing the expected output object
 * @param {number} [opts.maxTokens]
 * @returns {Promise<object>}
 */
export async function claudeJSON({ system, prompt, schema, maxTokens = 1500 }) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: [
      {
        name: "submit_result",
        description: "Submit your final structured result.",
        input_schema: schema,
      },
    ],
    tool_choice: { type: "tool", name: "submit_result" },
  });

  const toolUse = res.content.find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new Error(`Claude returned no structured output (stop_reason: ${res.stop_reason})`);
  }
  return toolUse.input;
}
