const MODEL = process.env.GLM_MODEL || "glm-4-flash";
const BASE_URL = process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";
const URL = `${BASE_URL}/chat/completions`;

// GLM free tier concurrency is strictly limited to 1.
// All GLM API calls must be paced sequentially to avoid 429/1302 rate limit errors.
const MIN_GAP_MS = 1500;
let queue = Promise.resolve();
let lastStart = 0;

function enqueue(fn) {
  const next = queue.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    return fn();
  });
  queue = next.catch(() => {}); // one failed call must not poison the queue
  return next;
}

/**
 * Recover a TRUNCATED tool-call JSON string. GLM-4-flash sometimes reports
 * finish_reason "tool_calls" (claiming it's done) but cuts the arguments off
 * mid-string — JSON.parse then throws "Unterminated string". Walk the text
 * tracking string/structure depth, close whatever's still open, and re-parse.
 * Returns the (partial) object, or null if it still can't be parsed. Applies to
 * every GLM schema: a half-written `output` is still useful context, and a
 * truncated build keeps the COMPLETE files (the cut-off last one degrades to a
 * partial the founder can finish in the Monaco editor) instead of failing the
 * whole mission. Falls through to the normal error if it still won't parse.
 */
function repairTruncatedJSON(s) {
  if (typeof s !== "string" || !s.trim()) return null;
  let inStr = false, esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  let fixed = s;
  if (inStr) fixed += '"'; // close the dangling string value
  fixed = fixed.replace(/,\s*$/, ""); // drop a trailing comma before a missing element
  for (let i = stack.length - 1; i >= 0; i--) fixed += stack[i] === "{" ? "}" : "]";
  try {
    const obj = JSON.parse(fixed);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Same contract as anthropicJSON / geminiJSON / groqJSON, backed by Zhipu AI (GLM) API.
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
      const res = await enqueue(() =>
        fetch(URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        })
      );

      if (res.ok) {
        const data = await res.json();
        const choice = data.choices?.[0];
        const call = choice?.message?.tool_calls?.[0];
        if (!call) {
          throw new Error(
            `GLM returned no structured output (finish_reason: ${choice?.finish_reason ?? "unknown"})`
          );
        }
        // A hit max_tokens cap truncates the tool-call arguments mid-string, so
        // JSON.parse throws "Unterminated string". Surface that as an actionable
        // error (raise maxTokens) instead of a cryptic parse crash.
        try {
          return JSON.parse(call.function.arguments);
        } catch (parseErr) {
          // Salvage a truncated tool call (the common GLM-flash flake) so a
          // partial-but-usable result degrades gracefully instead of hard-failing.
          const repaired = repairTruncatedJSON(call.function.arguments);
          if (repaired) {
            console.warn(`[glm] recovered truncated JSON (finish_reason: ${choice?.finish_reason ?? "unknown"})`);
            return repaired;
          }
          if (choice?.finish_reason === "length") {
            throw new Error(
              "GLM hit the max_tokens cap and returned truncated JSON — raise maxTokens for this call."
            );
          }
          throw new Error(
            `GLM returned invalid JSON (finish_reason: ${choice?.finish_reason ?? "unknown"}): ${String(parseErr.message)}`
          );
        }
      }

      const errText = await res.text();
      lastError = new Error(`GLM API ${res.status}: ${errText.slice(0, 300)}`);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    } catch (err) {
      lastError = err;
    }

    const delay = attempt * 2000;
    console.log(`[glm] ${String(lastError?.message || "error").slice(0, 90)} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`);
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
      res = await enqueue(() =>
        fetch(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        })
      );
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
      const res = await enqueue(() =>
        fetch(URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        })
      );

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
