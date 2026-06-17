const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Gemini's responseSchema accepts an OpenAPI-style subset of JSON Schema —
// unknown keys can be rejected, so keep only what it understands.
const ALLOWED_KEYS = new Set([
  "type", "description", "enum", "properties", "required", "items", "minItems", "maxItems", "nullable",
]);

function sanitizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema && typeof schema === "object") {
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties") {
        out.properties = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, sanitizeSchema(v)])
        );
      } else if (ALLOWED_KEYS.has(key)) {
        out[key] = key === "items" ? sanitizeSchema(value) : value;
      }
    }
    return out;
  }
  return schema;
}

// The free tier allows only a handful of requests per minute, and the
// orchestrator runs agents in parallel — so all Gemini calls go through one
// queue with a minimum gap between request starts.
const MIN_GAP_MS = 6500;
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

// Google's 429 responses include the exact delay to wait, e.g. "retryDelay": "22s"
function retryDelayMs(errText) {
  const m = errText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) + 1000 : 30_000;
}

/**
 * Low-level Gemini call shared by all features (agents + AYUS's chat):
 * one process-wide queue, free-tier pacing, and 429-aware retries.
 * Returns the raw response JSON.
 */
export async function geminiGenerate(body, { attempts = 5 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set (get one at aistudio.google.com)");

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await enqueue(() =>
      fetch(`${BASE}/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      })
    );

    if (res.ok) return res.json();

    const errText = await res.text();
    lastError = new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
    if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    const delay = res.status === 429 ? retryDelayMs(errText) : attempt * 2000;
    console.log(`[gemini] ${res.status} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts})`);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastError;
}

/**
 * Same contract as claudeJSON, backed by the Gemini API.
 * Structured output is enforced via responseSchema, so the reply is
 * guaranteed to be valid JSON in the requested shape.
 */
export async function geminiJSON({ system, prompt, schema, maxTokens = 1500 }) {
  const data = await geminiGenerate({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
      responseSchema: sanitizeSchema(schema),
    },
  });

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) {
    throw new Error(
      `Gemini returned no text (finishReason: ${data.candidates?.[0]?.finishReason ?? "unknown"})`
    );
  }
  return JSON.parse(text);
}
