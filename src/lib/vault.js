import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_VAULT_PATH = process.env.KNOWLEDGE_VAULT_PATH || "F:\\ANISH";

// Embedded seed catalog from F:\ANISH\System\graph.html
const RAW_SEED = [
  ["anish", "Anish Patankar", "self", "core", "", "", "", "F:\\ANISH\\Identity\\Anish Patankar.md", ""],
  ["home", "Home", "self", "note", "", "", "", "F:\\ANISH\\Home.md", ""],
  ["inbox", "Inbox", "self", "note", "", "", "", "F:\\ANISH\\Inbox\\Inbox.md", ""],
  ["liveprod", "Live Products", "self", "note", "", "", "", "F:\\ANISH\\Projects\\Live Products.md", ""],
  ["beram", "BERAM Pvt. Ltd.", "beram", "org", "", "", "beramdrones.com", "F:\\ANISH\\Orgs\\BERAM.md", "https://beramdrones.com"],
  ["ayus", "AYUS Labs", "ayus", "org", "", "", "github.com/AYUS974", "F:\\ANISH\\Orgs\\AYUS Labs.md", "https://ayuslabs.com"],
  ["rcoem", "RCOEM", "rcoem", "org", "", "", "", "F:\\ANISH\\Orgs\\RCOEM.md", ""],
  ["hubAP", "F:\\Anish Projects", "personal", "hub", "", "", "", "F:\\Anish Projects", ""],
  ["p1", "Anish974", "personal", "project", "", "2026-07-28", "github.com/Anish974/Anish974", "F:\\Anish Projects\\Anish974", ""],
  ["p2", "popcode", "ayus", "project", "python", "", "", "F:\\AYUS Labs\\popcode", ""],
  ["p3", "BeRam-Website", "beram", "project", "python", "2026-07-25", "github.com/Anish974/BeRam-Website", "F:\\BERAM Projects\\BeRam-Website", ""],
  ["p4", "ayus-universal-hub", "ayus", "project", "node", "2026-07-24", "github.com/Anish974/ayus-universal-hub", "F:\\AYUS Labs\\ayus-universal-hub", ""],
  ["p5", "anish-portfolio", "personal", "project", "node", "2026-07-24", "github.com/Anish974/anish-portfolio", "F:\\Anish Projects\\anish-portfolio", "https://anishpatankar.vercel.app/"],
  ["p6", "UTMS-APP", "beram", "project", "node", "", "", "F:\\BERAM Projects\\UTMS-APP", ""],
  ["p7", "sticktoon-new", "personal", "project", "node", "2026-07-23", "github.com/sticktoon/sticktoon-new", "F:\\Anish Projects\\sticktoon-new", "https://sticktoon.shop/"],
  ["p8", "n8n-data", "ayus", "project", "", "", "", "F:\\AYUS Labs\\n8n-data", ""],
  ["p9", "n8n-1", "ayus", "project", "node", "2026-07-20", "github.com/n8n-io/n8n", "F:\\AYUS Labs\\n8n-1", ""],
  ["p10", "n8n", "ayus", "project", "node", "2026-07-20", "github.com/n8n-io/n8n", "F:\\AYUS Labs\\n8n", ""],
  ["p11", "DocFlow", "ayus", "project", "node", "2026-07-19", "github.com/AYUS974/docFlow", "F:\\AYUS Labs\\DocFlow", "https://docflow.ayuslabs.com/"],
  ["p12", "PROT-HQNN", "personal", "project", "python", "2026-07-19", "github.com/Anish974/protein-function-qcnn", "F:\\Anish Projects\\PROT-HQNN", ""],
  ["p13", "DroSky", "ayus", "project", "node", "2026-07-19", "github.com/Anish974/DroSky", "F:\\AYUS Labs\\DroSky", "https://drosky.ayuslabs.com"],
  ["p14", "UTMS-MVP", "beram", "project", "node", "2026-07-17", "github.com/Anish974/UTMS-MVP", "F:\\BERAM Projects\\UTMS-MVP", ""],
  ["p15", "ModelX", "ayus", "project", "node", "", "", "F:\\AYUS Labs\\ModelX", ""],
  ["p16", "NEW-BERAM", "beram", "project", "node", "", "", "F:\\BERAM Projects\\NEW-BERAM", ""],
  ["p17", "UTMS-MOBILE", "beram", "project", "node", "2026-07-11", "github.com/Anish974/UTMS-MVP", "F:\\BERAM Projects\\UTMS-MOBILE", ""],
  ["p18", "New folder", "ayus", "project", "", "", "", "F:\\AYUS Labs\\New folder", ""],
  ["p19", "PrismTask", "ayus", "project", "node", "2026-07-06", "", "F:\\AYUS Labs\\PrismTask", ""],
  ["p20", "AutoRun", "ayus", "project", "node", "2026-07-06", "", "F:\\AYUS Labs\\AutoRun", ""],
  ["p21", "SkyForge", "ayus", "project", "node", "2026-07-05", "github.com/AYUS974/drone-simulator", "F:\\AYUS Labs\\SkyForge", "https://simulator.beramdrones.com"],
  ["p22", "InfoColl", "ayus", "project", "node", "2026-07-04", "github.com/AYUS974/college-compass", "F:\\AYUS Labs\\InfoColl", ""],
  ["p23", "Praxis", "ayus", "project", "node", "2026-07-04", "github.com/AYUS974/praxis", "F:\\AYUS Labs\\Praxis", "https://praxis.ayuslabs.com"],
  ["p24", "Other UTM", "ayus", "project", "node", "2026-07-03", "", "F:\\AYUS Labs\\Other UTM", ""],
  ["p25", "ayus-ops", "ayus", "project", "node", "2026-06-30", "github.com/AYUS974/AYUS-OPS", "F:\\AYUS Labs\\ayus-ops", ""],
  ["p27", "limitup", "ayus", "project", "node", "2026-06-26", "github.com/Anish974/limitup.ai", "F:\\AYUS Labs\\limitup", "https://limitup.site"],
  ["p28", "ytstar", "personal", "project", "", "2026-06-25", "github.com/Anish974/yt-star", "F:\\Anish Projects\\ytstar", ""],
  ["p29", "utms-native-app", "beram", "project", "node", "", "", "F:\\BERAM Projects\\utms-native-app", ""],
  ["p30", "Employee Management System", "ayus", "project", "node", "", "", "F:\\AYUS Labs\\Employee Management System- AYUS", ""],
  ["p31", "AYUS AI", "personal", "project", "", "", "", "F:\\Anish Projects\\AYUS AI", ""],
  ["p32", "Learn A New Thing Series", "personal", "project", "", "", "", "F:\\Anish Projects\\Learn A New Thing Series", ""],
  ["p33", "Dhanayush", "personal", "project", "flutter", "", "", "F:\\Anish Projects\\Dhanayush", ""],
  ["p35", "queston", "personal", "project", "node", "2026-06-01", "github.com/Anish974/queston", "F:\\Anish Projects\\queston", ""],
  ["p36", "queston", "ayus", "project", "node", "2026-06-01", "github.com/Anish974/queston", "F:\\AYUS Labs\\queston", ""],
  ["p45", "button-badge-template", "personal", "project", "node", "2026-02-18", "github.com/Anish974/button-badge-template", "F:\\Anish Projects\\button-badge-template", ""],
  ["p46", "ResumeWell", "personal", "project", "node", "2026-02-16", "github.com/Anish974/ResumeWell", "F:\\Anish Projects\\ResumeWell", ""],
  ["p48", "timestamper-frontend", "personal", "project", "node", "2026-01-17", "github.com/Anish974/Timestamper-frontend", "F:\\Anish Projects\\timestamper-frontend", ""],
  ["p49", "timestamper-backend", "personal", "project", "node", "2026-01-17", "github.com/Anish974/Timestamper-backend", "F:\\Anish Projects\\timestamper-backend", ""],
  ["p50", "TimeStamper", "personal", "project", "node", "2025-12-29", "github.com/Anish974/TimeStamper", "F:\\Anish Projects\\TimeStamper", ""],
  ["p51", "reelsvid", "personal", "project", "node", "2025-12-22", "github.com/Anish974/Anime-Reels-Editor", "F:\\Anish Projects\\reelsvid", ""],
  ["p54", "her-reading-nook", "personal", "project", "node", "2025-07-27", "github.com/Anish974/her-reading-nook", "F:\\Anish Projects\\her-reading-nook", ""]
];

const SEED_NOTES = {
  anish: "Co-founder of BERAM, runs AYUS Labs, B.Tech CSE (AI & ML) at RCOEM, class of 2026. Nagpur.",
  home: "Map of content for the whole vault.",
  inbox: "Four open cleanup items, including plaintext MQTT credentials to rotate.",
  liveprod: "Nine products deployed and reachable.",
  beram: "Drone technology company. Co-founded June 2025. Builds UTMS.",
  ayus: "Digital product studio. DocFlow, Praxis, DroSky, LimitUP.",
  rcoem: "Sports Secretary AIML Dept, Volleyball captain, former Creative Lead.",
  p14: "UTMS core — mission planning, drone registry, MAVLink/Pixhawk telemetry.",
  p21: "WebGL FPV flight simulator, built for BERAM.",
  p25: "Agent ops system. Seven named agents, full docs wiki on disk.",
  p11: "Client-side PDF editing over WebAssembly. Files never upload.",
  p9: "Upstream n8n clone — not your code.",
  p10: "Upstream n8n clone — not your code."
};

const SEED_LINKS = [
  ["anish", "home", ""], ["anish", "inbox", ""], ["anish", "liveprod", ""],
  ["anish", "beram", ""], ["anish", "ayus", ""], ["anish", "rcoem", ""],
  ["anish", "hubAP", ""],
  ["beram", "p21", "x"], ["rcoem", "p12", "x"], ["rcoem", "p22", "x"],
  ["p14", "p6", "x"], ["p14", "p17", "x"], ["p14", "p29", "x"], ["p14", "p16", "x"],
  ["liveprod", "p11", "x"], ["liveprod", "p13", "x"], ["liveprod", "p23", "x"],
  ["liveprod", "p27", "x"], ["liveprod", "p21", "x"], ["liveprod", "p7", "x"],
  ["liveprod", "p5", "x"],
  ["p35", "p36", "d"]
];

const HUB_OF = { beram: "beram", ayus: "ayus", personal: "hubAP", rcoem: "rcoem" };

const CLUSTER_MAP = {
  self: "Anish",
  beram: "BERAM",
  ayus: "AYUS Labs",
  rcoem: "RCOEM",
  personal: "Anish Projects",
};

/**
 * Helper to recursively scan a folder for .md files
 */
async function scanMarkdownFiles(dirPath, baseDir = dirPath) {
  let files = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        const subFiles = await scanMarkdownFiles(fullPath, baseDir);
        files = files.concat(subFiles);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        files.push({ fullPath, relPath, filename: entry.name });
      }
    }
  } catch (err) {
    // vault scanning fallback
  }
  return files;
}

/**
 * Parse frontmatter and content from markdown text
 */
function parseFrontmatter(text) {
  let frontmatter = {};
  // refresh.ps1 writes the vault notes as UTF-8 *with* a BOM, and a leading
  // ﻿ stops "^---" from matching — every note then parses as having no
  // frontmatter at all.
  let content = String(text || "").replace(/^﻿/, "");
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    const fmStr = fmMatch[1];
    // slice `content`, not `text` - offsets are relative to the stripped string
    content = content.slice(fmMatch[0].length);
    fmStr.split("\n").forEach((line) => {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join(":").trim();
        frontmatter[key] = val;
      }
    });
  }
  return { frontmatter, content };
}

/**
 * Extract [[Wikilinks]] from markdown content
 */
function parseWikilinks(text) {
  const links = new Set();
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const target = match[1].trim();
    if (target) links.add(target);
  }
  return Array.from(links);
}

/**
 * Scan vault and generate Graph Data with Rich Seed Catalog
 */
export async function getVaultGraph() {
  const vaultPath = DEFAULT_VAULT_PATH;
  const files = await scanMarkdownFiles(vaultPath);

  const nodes = [];
  const nameToId = new Map();
  const rawLinks = [...SEED_LINKS];

  // 1. Process Embedded SEED Catalog
  for (const item of RAW_SEED) {
    const [id, label, cluster, kind, stack, commit, remote, diskPath, live] = item;
    const clusterLabel = CLUSTER_MAP[cluster] || cluster;

    const node = {
      id,
      title: label,
      cluster,
      category: clusterLabel,
      kind,
      stack,
      commit,
      remote,
      fullPath: diskPath,
      live,
      excerpt: SEED_NOTES[id] || "",
      relPath: diskPath.replace(/\\/g, "/"),
      wikilinks: [],
      lineCount: 0,
      mtime: commit ? new Date(commit + "T00:00:00Z").toISOString() : new Date().toISOString(),
    };

    // Check if matching markdown file exists in vault
    const matchingFile = files.find((f) => f.filename.replace(/\.md$/i, "").toLowerCase() === label.toLowerCase() || f.relPath.toLowerCase().includes(label.toLowerCase()));
    if (matchingFile) {
      try {
        const text = await fs.readFile(matchingFile.fullPath, "utf8");
        const { frontmatter, content } = parseFrontmatter(text);
        node.wikilinks = parseWikilinks(text);
        node.fullPath = matchingFile.fullPath;
        node.relPath = matchingFile.relPath;
        node.lineCount = content.split("\n").length;
        if (!node.excerpt) {
          const lines = content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("---"));
          node.excerpt = lines.slice(0, 2).join(" ").slice(0, 160) + (lines.length > 0 ? "..." : "");
        }
      } catch {
        /* skip read error */
      }
    }

    nodes.push(node);
    nameToId.set(id.toLowerCase(), id);
    nameToId.set(label.toLowerCase(), id);
  }

  // 2. Add structural links from HUB_OF
  nodes.forEach((n) => {
    if (n.kind === "project") {
      const hub = HUB_OF[n.cluster];
      if (hub && hub !== n.id) rawLinks.push([hub, n.id, ""]);
    }
  });

  // 3. Process additional files found in vault not in seed
  for (const file of files) {
    const baseName = file.filename.replace(/\.md$/i, "");
    if (!nameToId.has(baseName.toLowerCase())) {
      try {
        const stats = await fs.stat(file.fullPath);
        const text = await fs.readFile(file.fullPath, "utf8");
        const { frontmatter, content } = parseFrontmatter(text);
        const wikilinks = parseWikilinks(text);

        const id = file.relPath.replace(/\.md$/i, "").replace(/\//g, "_").toLowerCase();
        const parts = file.relPath.split("/");
        const category = parts.length > 1 ? parts[0] : "General";

        const node = {
          id,
          title: baseName,
          cluster: category.toLowerCase(),
          category,
          kind: "note",
          stack: "",
          commit: "",
          remote: "",
          fullPath: file.fullPath,
          relPath: file.relPath,
          live: "",
          excerpt: content.split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(0, 2).join(" ").slice(0, 160),
          wikilinks,
          lineCount: content.split("\n").length,
          mtime: stats.mtime,
        };

        nodes.push(node);
        nameToId.set(id.toLowerCase(), id);
        nameToId.set(baseName.toLowerCase(), id);

        wikilinks.forEach((target) => {
          rawLinks.push([id, target, "x"]);
        });
      } catch {
        /* ignore */
      }
    }
  }

  // 4. Resolve Edges
  const links = [];
  const edgeSet = new Set();
  for (const [src, tgt, type] of rawLinks) {
    const sId = nameToId.get(src.toLowerCase()) || src;
    const tId = nameToId.get(tgt.toLowerCase()) || tgt;
    if (sId && tId && sId !== tId) {
      const edgeKey = `${sId}->${tId}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        links.push({ source: sId, target: tId, type });
      }
    }
  }

  return {
    vaultPath,
    totalNotes: nodes.length,
    totalLinks: links.length,
    nodes,
    links,
  };
}

/**
 * Get full note content by ID or relative path
 */
export async function getVaultNote(noteIdOrPath) {
  const vaultGraph = await getVaultGraph();
  const target = String(noteIdOrPath).toLowerCase();

  let targetNode = vaultGraph.nodes.find(
    (n) => n.id === target || n.title.toLowerCase() === target || n.relPath.toLowerCase() === target
  );

  if (!targetNode) {
    targetNode = vaultGraph.nodes[0];
  }

  let rawText = "";
  try {
    rawText = await fs.readFile(targetNode.fullPath, "utf8");
  } catch {
    rawText = `# ${targetNode.title}\n\n${targetNode.excerpt || "Note content located on disk."}\n\n- **Path**: \`${targetNode.fullPath}\`\n- **Category**: ${targetNode.category}\n- **Stack**: ${targetNode.stack || "N/A"}\n- **Remote**: ${targetNode.remote || "N/A"}\n- **Live URL**: ${targetNode.live || "N/A"}`;
  }

  const { frontmatter, content } = parseFrontmatter(rawText);

  // Backlinks & Outgoing
  const backlinks = vaultGraph.nodes
    .filter((n) => n.wikilinks.some((w) => w.toLowerCase() === targetNode.title.toLowerCase()))
    .map((n) => ({ id: n.id, title: n.title, relPath: n.relPath, category: n.category }));

  const outgoing = vaultGraph.links
    .filter((l) => l.source === targetNode.id)
    .map((l) => {
      const dest = vaultGraph.nodes.find((n) => n.id === l.target);
      return dest
        ? { id: dest.id, title: dest.title, relPath: dest.relPath, category: dest.category }
        : { id: l.target, title: l.target, relPath: "", category: "General" };
    });

  return {
    node: targetNode,
    content,
    frontmatter,
    backlinks,
    outgoing,
  };
}

// ---------------------------------------------------------------------------
// Docs catalog — the per-project markdown that F:\ANISH\System\refresh.ps1
// mirrors out of every repo into <vault>\Docs\<Project>\...
//
// getVaultGraph() above models the vault as a link graph; this models it as a
// library: projects, their documents, and the text inside them.
// ---------------------------------------------------------------------------

const DOCS_JUNK = /node_modules|[\\/]\.git[\\/]|venv|site-packages|ExtLibs|\.next|__pycache__/;
const DOCS_TTL_MS = 60_000;

let _docsCache = null;
let _docsCacheAt = 0;

/** Frontmatter (group / stack / remote / last_commit) from Projects\<Name>.md. */
async function readProjectMeta(vaultPath) {
  const meta = new Map();
  const dir = path.join(vaultPath, "Projects");
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return meta;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name === "_Index.md") continue;
    try {
      const raw = await fs.readFile(path.join(dir, e.name), "utf8");
      const { frontmatter } = parseFrontmatter(raw);
      const unquote = (v) => String(v || "").replace(/^"|"$/g, "");
      meta.set(e.name.replace(/\.md$/, ""), {
        group: unquote(frontmatter.group),
        stack: unquote(frontmatter.stack),
        remote: unquote(frontmatter.remote),
        commit: unquote(frontmatter.last_commit),
      });
    } catch {
      // a project note that will not parse just gets no metadata
    }
  }
  return meta;
}

/**
 * Whole docs library, bodies included, cached for a minute. ~1.5 MB in memory —
 * cheap, and it makes search a plain string scan instead of 169 file reads.
 */
async function loadDocs() {
  if (_docsCache && Date.now() - _docsCacheAt < DOCS_TTL_MS) return _docsCache;

  const vaultPath = DEFAULT_VAULT_PATH;
  const docsDir = path.join(vaultPath, "Docs");
  const meta = await readProjectMeta(vaultPath);

  const projects = [];
  const docs = [];

  let dirs = [];
  try {
    dirs = await fs.readdir(docsDir, { withFileTypes: true });
  } catch {
    return { vaultPath, projects, docs, generatedAt: new Date().toISOString() };
  }

  for (const dirent of dirs.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const projectDir = path.join(docsDir, dirent.name);
    const files = (await scanMarkdownFiles(projectDir)).filter((f) => !DOCS_JUNK.test(f.fullPath));
    if (!files.length) continue;

    const m = meta.get(dirent.name) || { group: "", stack: "", remote: "", commit: "" };
    let words = 0;
    let newest = 0;

    for (const f of files) {
      let raw = "";
      let mtime = 0;
      try {
        raw = await fs.readFile(f.fullPath, "utf8");
        mtime = (await fs.stat(f.fullPath)).mtimeMs;
      } catch {
        continue;
      }
      const heading = raw.split("\n").slice(0, 40).find((l) => /^#\s+\S/.test(l));
      const title = heading ? heading.replace(/^#\s+/, "").trim() : f.filename.replace(/\.md$/, "");
      const wc = raw.split(/\s+/).filter(Boolean).length;

      words += wc;
      if (mtime > newest) newest = mtime;

      docs.push({
        project: dirent.name,
        rel: f.relPath,
        title,
        words: wc,
        updated: new Date(mtime).toISOString().slice(0, 10),
        body: raw,
      });
    }

    projects.push({
      name: dirent.name,
      group: m.group,
      stack: m.stack,
      remote: m.remote,
      commit: m.commit,
      files: files.length,
      words,
      updated: new Date(newest || Date.now()).toISOString().slice(0, 10),
    });
  }

  _docsCache = { vaultPath, projects, docs, generatedAt: new Date().toISOString() };
  _docsCacheAt = Date.now();
  return _docsCache;
}

/** Catalog only — every project and document, without the bodies. */
export async function getDocsCatalog() {
  const { projects, docs, generatedAt } = await loadDocs();
  return {
    generatedAt,
    projects,
    docs: docs.map(({ body, ...rest }) => rest),
    totals: {
      projects: projects.length,
      docs: docs.length,
      words: projects.reduce((a, p) => a + p.words, 0),
    },
  };
}

/**
 * One document's markdown. `project` and `rel` arrive from the client, so the
 * resolved path is checked to be inside Docs/ before anything is read —
 * otherwise "../../../etc/passwd" walks straight out of the vault.
 */
export async function getDocBody(project, rel) {
  const docsDir = path.resolve(path.join(DEFAULT_VAULT_PATH, "Docs"));
  const target = path.resolve(path.join(docsDir, String(project || ""), String(rel || "")));

  if (target !== docsDir && !target.startsWith(docsDir + path.sep)) {
    throw new Error("path outside the docs folder");
  }
  if (!target.toLowerCase().endsWith(".md")) {
    throw new Error("not a markdown file");
  }

  const body = await fs.readFile(target, "utf8");
  return { project, rel, body };
}

/** Full-text scan across every mirrored document. */
export async function searchDocs(query, limit = 50) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { query: q, hits: [] };

  const { docs } = await loadDocs();
  const hits = [];

  for (const d of docs) {
    if (hits.length >= limit) break;
    const hay = (d.title + " " + d.rel + " " + d.body).toLowerCase();
    const at = hay.indexOf(q);
    if (at < 0) continue;
    const start = Math.max(0, at - 70);
    hits.push({
      project: d.project,
      rel: d.rel,
      title: d.title,
      words: d.words,
      updated: d.updated,
      snippet: (start ? "…" : "") + d.body.substr(start, 210).replace(/\s+/g, " ") + "…",
    });
  }

  return { query: q, hits };
}

export const VAULT_TOOLS = [
  {
    name: "vault_search",
    description: "Search notes in ANISH second brain knowledge vault by query string",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or keyword" },
        limit: { type: "integer", description: "Max results to return" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_read",
    description: "Read full content of a specific note in ANISH second brain vault by title or path",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "Note title or relative path" },
      },
      required: ["note"],
    },
  },
];

export async function vaultSearch({ query = "", limit = 5 } = {}) {
  try {
    const graph = await getVaultGraph();
    const q = String(query).toLowerCase();
    const matches = graph.nodes
      .filter((n) => n.title.toLowerCase().includes(q) || n.relPath.toLowerCase().includes(q) || (n.excerpt && n.excerpt.toLowerCase().includes(q)))
      .slice(0, limit);
    return { ok: true, matches: matches.map((m) => ({ id: m.id, title: m.title, relPath: m.relPath, excerpt: m.excerpt })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function vaultRead({ note = "" } = {}) {
  try {
    const target = typeof note === "object" ? note.note || note.path || "" : note;
    const noteData = await getVaultNote(target);
    return { ok: true, note: noteData };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
