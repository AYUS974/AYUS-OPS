// Notes — the founder's working memory for whatever he's building right now.
//
// Same JSON-file store as contacts.js: it's his private working set, it has to
// work the moment the page opens (no SQL migration), and AYUS writes to it far
// more often than a human does — every research report Arjun files lands here.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.NOTES_FILE || path.join(__dirname, "..", "..", "data", "notes.json");

async function readAll() {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// ponytail: read-modify-write, no lock — same as contacts. Fine for one founder
// plus his agents; add a queue if notes ever get written concurrently in bulk.
async function writeAll(list) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(list, null, 2));
}

/** Newest first — a notes list is read top-down. */
export async function listNotes({ project = "", q = "" } = {}) {
  const list = await readAll();
  const needle = q.trim().toLowerCase();
  return list
    .filter((n) => !project || n.project === project)
    .filter((n) => !needle || `${n.title} ${n.body} ${(n.tags || []).join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export async function saveNote({ id, title, body, project, tags, source }) {
  const clean = String(title || "").trim();
  if (!clean) throw new Error("title is required");

  const list = await readAll();
  const now = new Date().toISOString();
  const existing = id ? list.find((n) => n.id === id) : null;
  const note = {
    id: existing?.id || crypto.randomUUID(),
    title: clean,
    body: String(body || ""),
    project: String(project || existing?.project || "").trim(),
    tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : existing?.tags || [],
    source: source || existing?.source || "me", // me | ayus | research
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  await writeAll(existing ? list.map((n) => (n.id === note.id ? note : n)) : [note, ...list]);
  return note;
}

/** Append to an existing note (by exact title) or create it. How AYUS logs findings. */
export async function appendNote({ title, body, project, tags, source }) {
  const list = await readAll();
  const match = list.find((n) => n.title.toLowerCase() === String(title || "").trim().toLowerCase());
  if (!match) return saveNote({ title, body, project, tags, source });
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return saveNote({
    ...match,
    body: `${match.body}\n\n---\n_${stamp}_\n\n${body}`,
    project: project || match.project,
    tags: [...new Set([...(match.tags || []), ...(Array.isArray(tags) ? tags : [])])],
  });
}

export async function deleteNote(id) {
  const list = await readAll();
  const next = list.filter((n) => n.id !== id);
  if (next.length === list.length) throw new Error("note not found");
  await writeAll(next);
  return { ok: true };
}

/** Distinct project names, for the sidebar filter and for AYUS's tool hints. */
export async function listProjects() {
  const list = await readAll();
  return [...new Set(list.map((n) => n.project).filter(Boolean))].sort();
}
