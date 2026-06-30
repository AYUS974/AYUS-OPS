const MODEL = process.env.GLM_MODEL || "glm-4-flash";
const BASE_URL = process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
const URL = `${BASE_URL}/chat/completions`;

/**
 * Same contract as claudeJSON / geminiJSON / groqJSON, backed by Zhipu AI (GLM) API.
 * Structured output is enforced via forced tool calling.
 *
 * @param {object} opts
 * @param {string} opts.system - role/persona for the agent
 * @param {string} opts.prompt - the task + data
 * @param {object} opts.schema - JSON Schema describing the expected output object
 * @param {number} [opts.maxTokens]
 * @returns {Promise<object>}
 */
export async function glmJSON({ system, prompt, schema, maxTokens = 1500 }, { attempts = 5 } = {}) {
  const apiKey = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY;
  if (!apiKey) throw new Error("ZHIPU_API_KEY or GLM_API_KEY is not set in environment variables");

  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "submit_result",
          description: "Submit your final structured result.",
          parameters: schema,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "submit_result" } },
  };

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        const call = data.choices?.[0]?.message?.tool_calls?.[0];
        if (!call) {
          throw new Error(
            `GLM returned no structured output (finish_reason: ${data.choices?.[0]?.finish_reason ?? "unknown"})`
          );
        }
        return JSON.parse(call.function.arguments);
      }

      const errText = await res.text();
      lastError = new Error(`GLM API ${res.status}: ${errText.slice(0, 300)}`);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    } catch (err) {
      lastError = err;
    }

    const delay = attempt * 2000;
    console.log(`[glm] Error/429 — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError;
}

/**
 * Low-level GLM chat completion with optional tool calling. Returns the raw
 * assistant message object ({ content, tool_calls }).
 */
export async function glmChat(messages, tools, { maxTokens = 1200, temperature = 0.4, attempts = 3 } = {}) {
  const apiKey = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY;
  if (!apiKey) throw new Error("ZHIPU_API_KEY or GLM_API_KEY is not set");

  const body = { model: MODEL, max_tokens: maxTokens, temperature, messages };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message ?? { content: "" };
      }
      const errText = await res.text();
      lastError = new Error(`GLM API ${res.status}: ${errText.slice(0, 300)}`);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    } catch (err) {
      lastError = err;
    }
    const delay = attempt * 1500;
    console.log(`[glm] chat ${res?.status || "error"} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError;
}

/**
 * Streaming variant of glmChat. Calls `onDelta(textChunk)` as text tokens
 * arrive, assembles any tool calls across chunks, and resolves to the same
 * `{ content, tool_calls }` shape once the stream ends.
 */
export async function glmChatStream(messages, tools, { onDelta, maxTokens = 1200, temperature = 0.4 } = {}, { attempts = 3 } = {}) {
  const apiKey = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY;
  if (!apiKey) throw new Error("ZHIPU_API_KEY or GLM_API_KEY is not set");

  const body = { model: MODEL, max_tokens: maxTokens, temperature, messages, stream: true };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.tool_stream = true;
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        let content = "";
        const toolCalls = []; // assembled by streamed index
        const decoder = new TextDecoder();
        let buf = "";

        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            let json;
            try {
              json = JSON.parse(data);
            } catch {
              continue;
            }
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              content += delta.content;
              onDelta?.(delta.content);
            }
            for (const tc of delta.tool_calls || []) {
              const i = tc.index ?? 0;
              if (!toolCalls[i]) toolCalls[i] = { id: tc.id, type: "function", function: { name: "", arguments: "" } };
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
            }
          }
        }

        return { content, tool_calls: toolCalls.filter(Boolean) };
      }

      const errText = await res.text();
      lastError = new Error(`GLM API ${res.status}: ${errText.slice(0, 300)}`);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    } catch (err) {
      lastError = err;
    }

    const delay = attempt * 2000;
    console.log(`[glm] stream 429/Error — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError;
}
