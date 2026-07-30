// Markdown renderer for the Documentation page.
//
// Covers what the vault's documents actually contain: frontmatter, fenced code
// (including mermaid), ATX headings, GFM tables, lists, blockquotes with GitHub
// alert syntax, horizontal rules, and inline spans. Same renderer as
// F:\ANISH\System\docs.html, ported to an ES module.
//
// Fence placeholders use \u0001 / \u0002. Those are control characters, so no
// document text can collide with a placeholder — a plain-text sentinel like
// " F12 " very much can, and did.

const PH_A = "\u0001";
const PH_B = "\u0002";
const PH_ONE = /^\u0001\d+\u0002\s*$/;
const PH_ALL = /\u0001(\d+)\u0002/g;

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, txt, href) => {
      const external = /^(https?:|mailto:|#)/i.test(href);
      return `<a href="${href}"${external ? ' target="_blank" rel="noopener"' : ' data-rel="1"'}>${txt}</a>`;
    })
    .replace(/\[\[([^\]]+)\]\]/g, '<a href="#" data-wiki="$1">$1</a>')
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

function cells(row) {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Block parser. Recurses for blockquote bodies. It never touches fences —
 * extraction and restoration both happen in render(), so a nested call can pass
 * placeholders straight through instead of resolving them against a fresh list.
 */
function blocks(src, toc) {
  const lines = src.split("\n");
  const out = [];
  let para = [];
  let i = 0;

  const flushPara = () => {
    if (para.length) out.push("<p>" + inline(escapeHtml(para.join(" "))) + "</p>");
    para = [];
  };

  while (i < lines.length) {
    const ln = lines[i];

    if (PH_ONE.test(ln)) { flushPara(); out.push(ln.trim()); i++; continue; }
    if (!ln.trim())      { flushPara(); i++; continue; }

    const h = ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flushPara();
      const level = h[1].length;
      const text = h[2].trim();
      const id = slugify(text);
      if (level === 2 || level === 3) toc.push({ id, text, level });
      out.push(`<h${level} id="${id}">${inline(escapeHtml(text))}</h${level}>`);
      i++; continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(ln)) { flushPara(); out.push("<hr>"); i++; continue; }

    // GFM table: a header row followed by a separator row
    if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      const head = cells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      let t = '<div class="md-table"><table><thead><tr>';
      head.forEach((c) => { t += `<th>${inline(escapeHtml(c))}</th>`; });
      t += "</tr></thead><tbody>";
      rows.forEach((r) => {
        t += "<tr>";
        for (let k = 0; k < head.length; k++) t += `<td>${inline(escapeHtml(r[k] || ""))}</td>`;
        t += "</tr>";
      });
      out.push(t + "</tbody></table></div>");
      continue;
    }

    // blockquote — consume the whole run, then parse its body
    if (/^\s*>/.test(ln)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      let cls = "";
      let label = "";
      const alert = q[0] && q[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
      if (alert) {
        cls = alert[1].toLowerCase();
        if (cls === "important") cls = "note";
        label = `<span class="md-alert-label">${alert[1].toUpperCase()}</span>`;
        q.shift();
      }
      out.push(`<blockquote class="${cls}">${label}${blocks(q.join("\n"), toc)}</blockquote>`);
      continue;
    }

    // list — one level of nesting, by indent
    if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
      flushPara();
      const items = [];
      while (
        i < lines.length &&
        (/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))
      ) {
        const mi = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (mi) items.push({ indent: mi[1].length, ordered: /\d/.test(mi[2]), text: mi[3] });
        else items[items.length - 1].text += " " + lines[i].trim();   // wrapped continuation
        i++;
      }
      const ordered = items[0].ordered;
      const base = items[0].indent;
      let open = 0;
      let html = ordered ? "<ol>" : "<ul>";
      items.forEach((it) => {
        if (it.indent > base && !open) { html += it.ordered ? "<ol>" : "<ul>"; open = it.ordered ? 2 : 1; }
        else if (it.indent <= base && open) { html += open === 2 ? "</ol>" : "</ul>"; open = 0; }
        html += "<li>" + inline(escapeHtml(it.text)) + "</li>";
      });
      if (open) html += open === 2 ? "</ol>" : "</ul>";
      out.push(html + (ordered ? "</ol>" : "</ul>"));
      continue;
    }

    para.push(ln.trim());
    i++;
  }

  flushPara();
  return out.join("\n");
}

/** Markdown in, `{ html, toc }` out. */
export function renderMarkdown(src) {
  const fences = [];
  const toc = [];

  let text = String(src || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");   // frontmatter

  // pull fences out first so nothing inside them gets block-parsed
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    fences.push({ lang: (lang || "").trim().toLowerCase(), code });
    return PH_A + (fences.length - 1) + PH_B;
  });
  // the character class stops an inline span from swallowing a fence placeholder
  text = text.replace(/`([^`\n\u0001\u0002]+)`/g, (m, code) => {
    fences.push({ lang: "@inline", code });
    return PH_A + (fences.length - 1) + PH_B;
  });

  let html = blocks(text, toc);

  // restore fences once, at the end, against the one array that produced them
  html = html.replace(PH_ALL, (m, n) => {
    const f = fences[+n];
    if (!f) return "";
    if (f.lang === "@inline") return `<code>${escapeHtml(f.code)}</code>`;
    if (f.lang === "mermaid") return `<pre class="md-mermaid"><code>${escapeHtml(f.code.trim())}</code></pre>`;
    return `<pre><code>${escapeHtml(f.code.replace(/\n$/, ""))}</code></pre>`;
  });
  // a block element left alone inside a <p> — unwrap it
  html = html.replace(/<p>\s*(<pre[\s\S]*?<\/pre>)\s*<\/p>/g, "$1");

  return { html, toc };
}
