// Checks the Documentation page's two moving parts end to end, with no server
// and no auth needed:
//
//   1. src/lib/vault.js        - catalog, single-doc read, path-traversal guard, search
//   2. web/src/lib/markdown.js - the renderer, over a fixture and every real document
//
// Run: node scripts/test-vault-docs.mjs

import { renderMarkdown } from "../web/src/lib/markdown.js";
import { getDocsCatalog, getDocBody, searchDocs } from "../src/lib/vault.js";

let fail = 0;
const ok = (name, cond, extra) => {
  if (!cond) { fail++; console.log("FAIL  " + name + (extra ? "\n      " + extra : "")); }
  else console.log("ok    " + name);
};

// ===========================================================================
console.log("=== vault.js ===");
// ===========================================================================

const cat = await getDocsCatalog();
ok("catalog has projects", cat.projects.length > 20, cat.projects.length);
ok("catalog has docs", cat.docs.length > 100, cat.docs.length);
ok("totals match arrays", cat.totals.projects === cat.projects.length && cat.totals.docs === cat.docs.length);
ok("catalog carries no bodies", !("body" in cat.docs[0]), Object.keys(cat.docs[0]).join(","));
ok("word total is sane", cat.totals.words > 100000, cat.totals.words);
ok("every project has >=1 file", cat.projects.every((p) => p.files >= 1));
ok("every doc has a title", cat.docs.every((d) => d.title && d.title.length));
ok("every doc rel is forward-slashed", cat.docs.every((d) => !d.rel.includes("\\")));

// Project metadata comes from Projects\<Name>.md frontmatter. Those notes are
// written UTF-8 *with* a BOM, so this also guards parseFrontmatter's BOM strip.
const utms = cat.projects.find((p) => p.name === "UTMS-MVP");
ok("UTMS-MVP present", !!utms);
ok("frontmatter parsed past the BOM (group)", utms && utms.group.includes("BERAM"), utms && utms.group);
ok("frontmatter parsed past the BOM (remote)", utms && utms.remote.startsWith("https://"), utms && utms.remote);

const doc = await getDocBody("UTMS-MVP", "Architecture.md");
ok("body loads", doc.body.length > 5000, doc.body.length);
ok("body is the real file", doc.body.includes("UTMS-MVP"));

const nested = cat.docs.find((d) => d.rel.includes("/"));
if (nested) {
  const nb = await getDocBody(nested.project, nested.rel);
  ok("nested path loads (" + nested.rel + ")", nb.body.length > 0);
}

// `p` and `r` arrive straight from the client, so escaping the Docs folder must
// be impossible regardless of what is sent.
for (const [p, r] of [
  ["..", ".."],
  ["UTMS-MVP", "../../Home.md"],
  ["UTMS-MVP", "..\\..\\Home.md"],
  ["", "../../../Windows/win.ini"],
  ["UTMS-MVP/../..", "Home.md"],
]) {
  let threw = false;
  try { await getDocBody(p, r); } catch { threw = true; }
  ok(`traversal refused: p=${JSON.stringify(p)} r=${JSON.stringify(r)}`, threw);
}

let nonMd = false;
try { await getDocBody("..", "System/build-docs.ps1"); } catch { nonMd = true; }
ok("non-markdown refused", nonMd);

const s1 = await searchDocs("mavlink", 50);
ok("search finds mavlink", s1.hits.length > 3, s1.hits.length);
ok("hits carry a snippet", s1.hits.every((h) => h.snippet && h.snippet.length > 10));
ok("hits carry project + rel", s1.hits.every((h) => h.project && h.rel));
ok("1-char query returns nothing", (await searchDocs("a", 50)).hits.length === 0);
ok("nonsense query returns nothing", (await searchDocs("zzzznotathing", 50)).hits.length === 0);
ok("limit respected", (await searchDocs("the", 10)).hits.length <= 10);

// ===========================================================================
console.log("\n=== markdown.js ===");
// ===========================================================================

const fixture = [
  "---", "type: project", 'stack: "node"', "---", "",
  "# Title Here", "",
  "Intro with **bold**, *italic*, `inline code` and a [link](https://x.com).", "",
  "## Section Two", "",
  "| Col A | Col B |", "|---|---|", "| one | two |", "| three | `code` |", "",
  "- item one", "- item two", "  - nested item", "- item three", "",
  "1. first", "2. second", "",
  "> [!WARNING]", "> Careful with this.", "",
  "> plain quote", "",
  "```js", 'const x = "</script>";', "if (a < b && c > d) { }", "```", "",
  "```mermaid", "graph TD; A-->B;", "```", "",
  "---", "",
  "### Deep heading", "",
  "Final paragraph.", "",
].join("\n");

const r = renderMarkdown(fixture);
const h = r.html;

ok("frontmatter stripped", !h.includes("type: project"));
ok("h1", /<h1 id="title-here">Title Here<\/h1>/.test(h));
ok("h2 + id", /<h2 id="section-two">/.test(h));
ok("h3", /<h3 id="deep-heading">/.test(h));
ok("bold", h.includes("<strong>bold</strong>"));
ok("italic", h.includes("<em>italic</em>"));
ok("inline code", h.includes("<code>inline code</code>"));
ok("external link gets target", /<a href="https:\/\/x.com" target="_blank"/.test(h));
ok("table wrapper", h.includes('<div class="md-table"><table>'));
ok("table header", /<th>Col A<\/th><th>Col B<\/th>/.test(h));
ok("two body rows", (h.match(/<tr><td>/g) || []).length === 2);
ok("code in table cell", /<td><code>code<\/code><\/td>/.test(h));
ok("ul", /<ul><li>item one<\/li>/.test(h));
ok("nested list", /<ul><li>nested item<\/li><\/ul>/.test(h));
ok("ol", /<ol><li>first<\/li><li>second<\/li><\/ol>/.test(h));
ok("alert class", /<blockquote class="warning">/.test(h));
ok("alert label", h.includes('<span class="md-alert-label">WARNING</span>'));
ok("plain quote", /<blockquote class="">/.test(h));
ok("hr", h.includes("<hr>"));
ok("fence", h.includes("<pre><code>"));
// the renderer must never let document text escape as live markup
ok("script tag escaped", h.includes("&lt;/script&gt;") && !h.includes('const x = "</script>'));
ok("angle brackets escaped", h.includes("a &lt; b &amp;&amp; c &gt; d"));
ok("mermaid block", /<pre class="md-mermaid"><code>graph TD; A--&gt;B;/.test(h));
ok("no sentinel leak", !/[\u0001\u0002]/.test(h));
ok("toc has 2 entries", r.toc.length === 2, JSON.stringify(r.toc));

console.log("\n--- rendering all " + cat.docs.length + " real documents ---");

const unclosed = [];
const leaked = [];
let biggest = { n: 0 };

for (const d of cat.docs) {
  let body;
  try { body = (await getDocBody(d.project, d.rel)).body; }
  catch (e) { fail++; console.log("FAIL  fetch " + d.project + "/" + d.rel + ": " + e.message); continue; }

  let out;
  try { out = renderMarkdown(body); }
  catch (e) { fail++; console.log("FAIL  render " + d.project + "/" + d.rel + ": " + e.message); continue; }

  for (const tag of ["table", "ul", "ol", "blockquote", "pre"]) {
    const open = (out.html.match(new RegExp("<" + tag + "[ >]", "g")) || []).length;
    const close = (out.html.match(new RegExp("</" + tag + ">", "g")) || []).length;
    if (open !== close) unclosed.push(`${d.project}/${d.rel} <${tag}> ${open}/${close}`);
  }
  if (/[\u0001\u0002]/.test(out.html)) leaked.push(d.project + "/" + d.rel);
  if (out.html.length > biggest.n) biggest = { d: d.project + "/" + d.rel, n: out.html.length };
}

ok("all documents render", true);
ok("no unbalanced block tags", unclosed.length === 0, unclosed.slice(0, 6).join("\n      "));
ok("no sentinel leaks", leaked.length === 0, leaked.slice(0, 6).join(", "));
console.log("largest: " + biggest.d + " (" + biggest.n.toLocaleString() + " chars)");

console.log(fail ? "\n" + fail + " FAILING" : "\nall green");
process.exit(fail ? 1 : 0);
