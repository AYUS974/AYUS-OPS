/**
 * Source grounding for missions.
 *
 * When the founder's objective contains URLs, we fetch those pages server-side
 * and hand their real text to the agents as authoritative context. Without this
 * the LLM can only answer from training memory — so "research AYUS Labs (here's
 * the site)" makes it recall some *other* similarly-named entity and ignore the
 * link. Grounding turns the link from inert prompt text into actual facts.
 *
 * Deliberately dependency-free (native fetch + a lightweight HTML→text strip),
 * with tight budgets so a big page can't blow the LLM's per-minute token limit.
 */

const MAX_PAGES = 3;
const PER_PAGE_CHARS = 4000;
const TOTAL_CHARS = 9000;
const FETCH_TIMEOUT_MS = 12000;
const READER_TIMEOUT_MS = 20000;
// Min readable chars before we trust a plain fetch. Below this the page is
// almost certainly a JS-rendered SPA (empty HTML shell) → use the reader.
const MIN_DIRECT_CHARS = 200;
// Jina AI's reader renders JS and returns clean text/markdown — keyless (set
// JINA_API_KEY for higher rate limits). This is how we read SPA sites that a
// plain fetch can't, e.g. ayuslabs.com (a Vite app).
const READER_PREFIX = "https://r.jina.ai/";

const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+/gi;

/** Pull http(s) URLs out of free text, de-duped and lightly cleaned. */
export function extractUrls(text) {
  const found = String(text || "").match(URL_RE) || [];
  const seen = new Set();
  const urls = [];
  for (let u of found) {
    u = u.replace(/[.,;:!?)\]}>'"]+$/, ""); // strip trailing sentence punctuation
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  return urls.slice(0, MAX_PAGES);
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–");
}

/** Crude but robust HTML → readable text (no DOM dependency). */
function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : "";
}

/** Plain fetch + HTML→text. Fast and private, but blind to JS-rendered pages. */
async function fetchDirect(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AYUS-Ops-Researcher/1.0; +https://ayuslabs.com)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const ctype = res.headers.get("content-type") || "";
    if (!/text|html|xml|json/i.test(ctype)) return { ok: false, error: `non-text content (${ctype || "unknown"})` };
    const html = await res.text();
    const title = titleOf(html);
    let text = htmlToText(html);
    if (text.length > PER_PAGE_CHARS) text = text.slice(0, PER_PAGE_CHARS) + "\n…[truncated]";
    return { ok: true, title, text };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "timeout" : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Render-aware fetch via Jina AI reader — reads SPAs a plain fetch can't. */
async function fetchViaReader(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READER_TIMEOUT_MS);
  try {
    const headers = { "User-Agent": "AYUS-Ops-Researcher/1.0", "X-Return-Format": "text" };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(READER_PREFIX + url, { signal: ctrl.signal, redirect: "follow", headers });
    if (!res.ok) return { ok: false, error: `reader HTTP ${res.status}` };
    let text = (await res.text()).trim();
    if (text.length > PER_PAGE_CHARS) text = text.slice(0, PER_PAGE_CHARS) + "\n…[truncated]";
    if (text.length < 40) return { ok: false, error: "reader returned no text" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "reader timeout" : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch one URL's readable text (never throws). Tries a plain fetch first; if
 * the page is a JS-only SPA (little/no server-rendered text), falls back to the
 * rendering reader so the agents still get real content.
 */
export async function fetchPageText(url) {
  const direct = await fetchDirect(url);
  if (direct.ok && direct.text.length >= MIN_DIRECT_CHARS) {
    return { url, ok: true, title: direct.title, text: direct.text };
  }
  const reader = await fetchViaReader(url);
  if (reader.ok) {
    return { url, ok: true, title: direct.title || "", text: reader.text, via: "reader" };
  }
  // Both paths thin/failed — report the most useful error we have.
  return { url, ok: false, title: direct.title || "", error: direct.error || reader.error || "no readable text" };
}

/**
 * Fetch every URL in the objective and assemble a grounding context block.
 * Returns { urls, fetched, failed, block } — block is "" when there's nothing
 * usable, so callers can cheaply skip grounding.
 */
export async function gatherSources(objective) {
  const urls = extractUrls(objective);
  if (!urls.length) return { urls: [], fetched: [], failed: [], block: "" };

  const pages = await Promise.all(urls.map(fetchPageText));
  const ok = pages.filter((p) => p.ok && p.text);
  const failed = pages.filter((p) => !p.ok);

  let block = ok
    .map((p) => `SOURCE: ${p.url}${p.title ? `\nTITLE: ${p.title}` : ""}\n---\n${p.text}`)
    .join("\n\n========\n\n");
  if (block.length > TOTAL_CHARS) block = block.slice(0, TOTAL_CHARS) + "\n…[truncated]";

  return { urls, fetched: ok.map((p) => p.url), failed, block };
}

/**
 * Wrap fetched sources in a strong instruction so agents treat them as the
 * single source of truth and stop confusing the subject with same-named
 * entities from training memory. Returns "" when there's no grounding.
 */
export function groundingPreface(block) {
  if (!block) return "";
  return (
    `GROUND-TRUTH SOURCES — fetched live from the link(s) in the objective. These are the ONLY authoritative facts about the subject.\n` +
    `Rules: (1) Base every claim about the subject on these sources. (2) Do NOT use prior knowledge of similarly-named companies/people — if it isn't in the sources, don't assert it. (3) If the sources don't cover something, say so rather than inventing it.\n\n` +
    `${block}\n\n=== END SOURCES ===\n\n`
  );
}
