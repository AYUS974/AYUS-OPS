const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const URL = "https://api.groq.com/openai/v1/chat/completions";
const STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Salvage a Groq `tool_use_failed` 400. Llama sometimes emits the forced tool
 * call as text (`<function=submit_result>{...}</function>`) rather than a
 * structured tool_call, so Groq rejects its OWN output — but returns the model's
 * real text in `error.failed_generation`. The JSON we wanted is in there; pull
 * the first balanced { … } object out and parse it. Returns null if the body
 * isn't a tool_use_failed error or the JSON is truncated/unparseable.
 */
function salvageToolUse(errText) {
  let body;
  try {
    body = JSON.parse(errText);
  } catch {
    return null;
  }
  const fg = body?.error?.failed_generation;
  if (typeof fg !== "string" || !fg) return null;

  const open = fg.indexOf("{");
  if (open < 0) return null;

  // Walk to the matching close brace, respecting strings/escapes, so a `{` or
  // `}` inside the file contents can't end the object early.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = open; i < fg.length; i++) {
    const c = fg[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { end = i; break; }
  }
  if (end < 0) return null; // truncated mid-object — let the caller retry

  try {
    return JSON.parse(fg.slice(open, end + 1));
  } catch {
    return null;
  }
}

/**
 * How long to wait before retrying a 429. Groq tells us EXACTLY when the limit
 * clears — either a `retry-after` header (seconds) or a "Please try again in
 * 20.8s" hint in the body. The free-tier per-minute token window won't reset
 * until then, so a blind 2s/4s backoff just burns attempts on more 429s (this is
 * what was failing the Mission revision pass). Honor the hint, with a small
 * buffer, capped so a pathological value can't hang the pipeline.
 */
function retryAfterMs(res, errText, fallbackMs) {
  const header = Number(res.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000 + 500, 30000);
  const m = /try again in ([\d.]+)\s*s/i.exec(errText || "");
  if (m) return Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 500, 30000);
  return fallbackMs;
}

/**
 * Speech-to-text via Groq's hosted Whisper. Fast (sub-second for short clips)
 * and handles Hinglish well, which is why AYUS uses it for voice input instead
 * of the browser's Chromium-only Web Speech API — this works in every browser.
 *
 * @param {Buffer} audio - raw audio bytes (webm/ogg/mp4/wav…)
 * @param {object} [opts]
 * @param {string} [opts.filename] - name hint so Whisper infers the container
 * @param {string} [opts.language] - ISO code (e.g. "en", "hi"); omit to auto-detect
 * @returns {Promise<string>} the transcript (trimmed)
 */
export async function groqTranscribe(audio, { filename = "speech.webm", language, prompt } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set (get one at console.groq.com)");

  const form = new FormData();
  form.append("file", new Blob([audio]), filename);
  form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  // A short context prompt biases Whisper's vocabulary and style — keeps it from
  // guessing the wrong language and helps it get the agent/product names right.
  if (prompt) form.append("prompt", prompt);

  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return String(data.text || "").trim();
}

/**
 * Low-level Groq chat completion with optional tool calling. Returns the raw
 * assistant message object ({ content, tool_calls }). Groq's inference is very
 * fast (sub-second), which is what makes AYUS feel near real-time.
 */
export async function groqChat(messages, tools, { maxTokens = 1200, temperature = 0.4, attempts = 3 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set (get one at console.groq.com)");

  const body = { model: MODEL, max_tokens: maxTokens, temperature, messages };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message ?? { content: "" };
    }
    const errText = await res.text();
    lastError = new Error(`Groq API ${res.status}: ${errText.slice(0, 300)}`);
    if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  throw lastError;
}

/**
 * Look at an image and answer a question about it. Kept on Groq because the
 * screen-reading path is interactive — Gemini's free tier 429s for a minute at
 * a time, which reads to the founder as "AYUS can't see my screen".
 *
 * @param {string} prompt   what to look for
 * @param {string} base64Png  screenshot, base64 (no data: prefix)
 * @returns {Promise<string>} the answer, reasoning stripped
 */
export async function groqVision(prompt, base64Png, { maxTokens = 1200 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set (get one at console.groq.com)");

  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b",
      max_tokens: maxTokens,
      temperature: 0.2,
      reasoning_effort: "none", // qwen thinks out loud otherwise, and the founder hears it
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64Png}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq vision ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = String(data.choices?.[0]?.message?.content || "");
  // Reasoning models narrate inside <think>…</think> — the founder only wants the answer.
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Streaming variant of groqChat. Calls `onDelta(textChunk)` as text tokens
 * arrive, assembles any tool calls across chunks, and resolves to the same
 * `{ content, tool_calls }` shape once the stream ends. This is what lets AYUS
 * start speaking before the full reply is generated.
 */
export async function groqChatStream(messages, tools, { onDelta, maxTokens = 1200, temperature = 0.4 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set (get one at console.groq.com)");

  const body = { model: MODEL, max_tokens: maxTokens, temperature, messages, stream: true };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Groq API ${res.status}: ${(await res.text()).slice(0, 300)}`);

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

/**
 * Same contract as anthropicJSON / geminiJSON, backed by the Groq API
 * (OpenAI-compatible Chat Completions). Structured output is enforced via
 * forced tool calling, so the reply is guaranteed valid JSON in the requested shape.
 *
 * @param {object} opts
 * @param {string} opts.system - role/persona for the agent
 * @param {string} opts.prompt - the task + data
 * @param {object} opts.schema - JSON Schema describing the expected output object
 * @param {number} [opts.maxTokens]
 * @returns {Promise<object>}
 */
export async function groqJSON({ system, prompt, schema, maxTokens = 1500 }, { attempts = 5 } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set (get one at console.groq.com)");

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
      const choice = data.choices?.[0];
      const call = choice?.message?.tool_calls?.[0];
      if (!call) {
        throw new Error(
          `Groq returned no structured output (finish_reason: ${choice?.finish_reason ?? "unknown"})`
        );
      }
      // A hit token cap truncates the tool-call arguments mid-string, so
      // JSON.parse throws "Unterminated string". Surface that as an actionable
      // error (raise maxTokens) instead of a cryptic parse crash.
      try {
        return JSON.parse(call.function.arguments);
      } catch (parseErr) {
        if (choice?.finish_reason === "length") {
          throw new Error("Groq hit the max_tokens cap and returned truncated JSON — raise maxTokens for this call.");
        }
        throw new Error(`Groq returned invalid JSON (finish_reason: ${choice?.finish_reason ?? "unknown"}): ${String(parseErr.message)}`);
      }
    }

    const errText = await res.text();
    // Recover a well-formed-but-mis-wrapped tool call before giving up.
    const salvaged = salvageToolUse(errText);
    if (salvaged) return salvaged;
    // tool_use_failed is a stochastic Llama formatting fluke (not a bad request
    // we can't fix), so it's worth retrying like a transient error.
    const toolFail = errText.includes("tool_use_failed");
    lastError = new Error(`Groq API ${res.status}: ${errText.slice(0, 300)}`);
    if (![429, 500, 502, 503, 504].includes(res.status) && !toolFail) throw lastError;
    // 429 = per-minute token cap; wait exactly as long as Groq says, else linear backoff.
    const delay = res.status === 429 ? retryAfterMs(res, errText, attempt * 2000) : attempt * 2000;
    console.log(`[groq] ${res.status}${toolFail ? " tool_use_failed" : ""} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError;
}
