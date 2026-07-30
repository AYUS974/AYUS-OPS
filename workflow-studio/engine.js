/**
 * Workflow engine (standalone, dependency-free).
 *
 * A workflow = { trigger, steps[] }. Steps run top-to-bottom; each step's output
 * is stored at ctx.steps[id].output and later steps template against it with
 * {{steps.<id>.output}} / {{trigger.payload.x}} / {{vars.x}} syntax.
 *
 * All step types except `http` run fully offline — no accounts, no keys — so
 * this app is genuinely portable. `llm` is optional and only fires if an
 * ANTHROPIC_API_KEY is present in the environment.
 */

const MAX_STEPS = 25;
const HTTP_TIMEOUT_MS = 20000;
const MAX_DELAY_S = 300;

// ---------- template resolution ----------

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Resolve {{ expr }} refs. A solo ref returns the raw value; inline refs stringify. */
export function resolve(value, ctx) {
  if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)]));
  }
  if (typeof value !== "string") return value;

  const solo = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (solo) {
    const v = getPath(ctx, solo[1]);
    return v === undefined ? "" : v;
  }
  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const v = getPath(ctx, expr.trim());
    if (v === undefined) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

// ---------- step handlers ----------

const HANDLERS = {
  // Set a named variable into ctx.vars (value may be templated).
  async set(cfg, ctx) {
    const key = String(cfg.key || "").trim();
    if (!key) throw new Error("set step needs a key");
    ctx.vars[key] = resolve(cfg.value, ctx);
    return ctx.vars[key];
  },

  // Produce a piece of text from a template — the workhorse for building payloads.
  async template(cfg, ctx) {
    return String(resolve(cfg.text ?? "", ctx));
  },

  // Real outbound HTTP request (the one step that needs the network).
  async http(cfg, ctx) {
    const url = String(resolve(cfg.url, ctx) || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("http step needs an http(s) url");
    const method = String(cfg.method || "GET").toUpperCase();
    const headers = resolve(cfg.headers || {}, ctx);
    const rawBody = resolve(cfg.body, ctx);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method,
        headers: headers && typeof headers === "object" ? headers : undefined,
        body:
          method === "GET" || method === "HEAD" || rawBody == null
            ? undefined
            : typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody),
        signal: ac.signal,
      });
      const text = (await r.text()).slice(0, 20000);
      let body = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      return { status: r.status, ok: r.ok, body };
    } finally {
      clearTimeout(timer);
    }
  },

  // Gate: stops the run cleanly if the comparison is false (a "filter" node).
  async condition(cfg, ctx) {
    const left = resolve(cfg.left, ctx);
    const right = resolve(cfg.right, ctx);
    const op = cfg.op || "==";
    const passed = compare(left, op, String(right));
    if (!passed) {
      const stop = new Error(`condition not met (${JSON.stringify(left)} ${op} ${JSON.stringify(right)})`);
      stop.stopRun = true; // engine treats this as a clean stop, not a failure
      throw stop;
    }
    return { passed: true };
  },

  async delay(cfg) {
    const seconds = Math.min(Math.max(Number(cfg.seconds) || 0, 0), MAX_DELAY_S);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return { waited: seconds };
  },

  async log(cfg, ctx) {
    const message = String(resolve(cfg.message, ctx) || "");
    console.log(`[workflow] ${message}`);
    return message;
  },

  // Optional: only works if ANTHROPIC_API_KEY is set. Kept dependency-free (raw fetch).
  async llm(cfg, ctx) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("llm step needs ANTHROPIC_API_KEY in the environment");
    const prompt = String(resolve(cfg.prompt, ctx) || "").trim();
    if (!prompt) throw new Error("llm step needs a prompt");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg.model || "claude-haiku-4-5-20251001",
        max_tokens: Math.min(Number(cfg.maxTokens) || 1024, 4096),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const data = await r.json();
    return data?.content?.[0]?.text || "";
  },
};

export const STEP_TYPES = Object.keys(HANDLERS);

function compare(left, op, right) {
  const l = typeof left === "string" ? left : JSON.stringify(left);
  switch (op) {
    case "==": return String(l) === right;
    case "!=": return String(l) !== right;
    case "contains": return String(l).includes(right);
    case ">": return Number(left) > Number(right);
    case "<": return Number(left) < Number(right);
    case "truthy": return Boolean(left);
    default: return false;
  }
}

function summarize(output) {
  if (output == null) return "";
  const s = typeof output === "string" ? output : JSON.stringify(output);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

// ---------- runner ----------

/**
 * Run one workflow to completion. Never throws. Returns
 * { ok, status, log[], error }. A `condition` that fails stops the run with
 * status "stopped" (clean), any other error stops it with status "error".
 */
export async function runWorkflow(workflow, { triggerType = "manual", payload = {} } = {}) {
  const steps = Array.isArray(workflow.steps) ? workflow.steps.slice(0, MAX_STEPS) : [];
  const ctx = { trigger: { type: triggerType, payload }, steps: {}, vars: {}, now: new Date().toISOString() };
  const log = [];
  let status = "ok";
  let error = null;

  if (!steps.length) {
    return { ok: false, status: "error", log: [{ step: "—", type: null, status: "error", message: "workflow has no steps", ms: 0 }], error: "workflow has no steps" };
  }

  for (const [i, step] of steps.entries()) {
    const type = step?.type;
    const label = step?.name || type || `step ${i + 1}`;
    const handler = HANDLERS[type];
    const t0 = Date.now();
    if (!handler) {
      log.push({ step: label, type, status: "error", message: `unknown step type "${type}"`, ms: 0 });
      status = "error";
      error = `unknown step type "${type}"`;
      break;
    }
    try {
      const output = await handler(step.config || {}, ctx, { workflow });
      ctx.steps[step.id || `s${i + 1}`] = { output };
      log.push({ step: label, type, status: "ok", message: summarize(output), ms: Date.now() - t0 });
    } catch (err) {
      if (err?.stopRun) {
        log.push({ step: label, type, status: "stopped", message: String(err.message), ms: Date.now() - t0 });
        status = "stopped";
        break;
      }
      log.push({ step: label, type, status: "error", message: String(err?.message || err), ms: Date.now() - t0 });
      status = "error";
      error = String(err?.message || err);
      break;
    }
  }

  return { ok: status !== "error", status, log, error };
}
