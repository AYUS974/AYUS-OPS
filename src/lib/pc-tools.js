import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const execAsync = promisify(exec);
const HOME = os.homedir();

/**
 * AYUS's laptop toolkit — READ and OPEN only, by design.
 *
 * Hard rules:
 *  - File access is confined to PC_ALLOWED_DIRS (env, semicolon-separated).
 *  - There are NO tools that write, move, delete, install or run arbitrary
 *    shell commands. Anything like that must go through the approval queue
 *    as a proposal the founder approves in the dashboard.
 */
const ALLOWED_DIRS = (
  process.env.PC_ALLOWED_DIRS ||
  ["F:\\AYUS Labs", path.join(HOME, "Desktop"), path.join(HOME, "Downloads"), path.join(HOME, "Documents")].join(";")
)
  .split(";")
  .map((d) => path.resolve(d.trim()))
  .filter(Boolean);

function assertAllowed(p) {
  const resolved = path.resolve(p);
  const ok = ALLOWED_DIRS.some(
    (dir) => resolved.toLowerCase() === dir.toLowerCase() ||
      resolved.toLowerCase().startsWith(dir.toLowerCase() + path.sep)
  );
  if (!ok) {
    throw new Error(
      `Access denied: "${resolved}" is outside the allowed folders (${ALLOWED_DIRS.join(", ")})`
    );
  }
  return resolved;
}

// `start` goes through cmd.exe, so never interpolate untrusted strings raw.
function cmdSafe(s) {
  if (/[&|<>^%"`$;]/.test(s)) throw new Error("input contains characters that are not allowed");
  return s;
}

async function startTarget(target) {
  await execAsync(`start "" "${cmdSafe(target)}"`, { shell: "cmd.exe", windowsHide: true });
}

// Known apps AYUS may launch by name. Protocol/exe based, no arbitrary commands.
const APPS = {
  spotify: "spotify:",
  whatsapp: "whatsapp:",
  chrome: "chrome",
  edge: "msedge",
  notepad: "notepad",
  calculator: "calc",
  explorer: "explorer",
  vscode: "code",
  vlc: "vlc",
  word: "winword",
  excel: "excel",
  settings: "ms-settings:",
  camera: "microsoft.windows.camera:",
  mail: "outlookmail:",
};

export const PC_TOOL_DECLARATIONS = [
  {
    name: "open_app",
    description:
      `Open an application on the founder's laptop. Known apps: ${Object.keys(APPS).join(", ")}.`,
    parameters: {
      type: "object",
      properties: { app: { type: "string", description: "App name from the known list" } },
      required: ["app"],
    },
  },
  {
    name: "spotify_play",
    description:
      "Open Spotify with a search for a song/artist/playlist so it's one click from playing. Use when asked to play music.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Song, artist or playlist to search" } },
      required: ["query"],
    },
  },
  {
    name: "open_url",
    description: "Open a website in the default browser (http/https only).",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "open_path",
    description: "Open a file or folder (inside the allowed folders) with its default application.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List the contents of a folder inside the allowed folders.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute folder path" } },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "Search for files by name (case-insensitive substring) inside the allowed folders. Returns up to 20 matches.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the file/folder name" },
        dir: { type: "string", description: "Optional: limit to one allowed folder" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a text file (inside the allowed folders) and return up to the first 6000 characters.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "system_info",
    description: "Get basic system info: time, OS, uptime, memory, allowed folders.",
    parameters: { type: "object", properties: {} },
  },
];

async function searchDir(root, query, results, depth = 0) {
  if (results.length >= 20 || depth > 5) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (results.length >= 20) return;
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(root, e.name);
    if (e.name.toLowerCase().includes(query)) results.push(full + (e.isDirectory() ? path.sep : ""));
    if (e.isDirectory()) await searchDir(full, query, results, depth + 1);
  }
}

export const PC_TOOL_HANDLERS = {
  async open_app({ app }) {
    const key = String(app || "").toLowerCase().trim();
    const target = APPS[key];
    if (!target) {
      return { ok: false, error: `Unknown app "${app}". Known apps: ${Object.keys(APPS).join(", ")}` };
    }
    await startTarget(target);
    return { ok: true, result: `Opened ${key}` };
  },

  async spotify_play({ query }) {
    const q = cmdSafe(String(query || "").trim()).slice(0, 80);
    if (!q) return { ok: false, error: "empty query" };
    await startTarget(`spotify:search:${encodeURIComponent(q)}`);
    return {
      ok: true,
      result: `Opened Spotify search for "${q}" — top result is one click from playing`,
    };
  },

  async open_url({ url }) {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: "only http/https URLs allowed" };
    await startTarget(u);
    return { ok: true, result: `Opened ${u} in the browser` };
  },

  async open_path({ path: p }) {
    const resolved = assertAllowed(p);
    await fs.access(resolved);
    await startTarget(resolved);
    return { ok: true, result: `Opened ${resolved}` };
  },

  async list_dir({ path: p }) {
    const resolved = assertAllowed(p);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return {
      ok: true,
      result: entries
        .slice(0, 60)
        .map((e) => e.name + (e.isDirectory() ? "/" : ""))
        .join("\n"),
    };
  },

  async search_files({ query, dir }) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return { ok: false, error: "empty query" };
    const roots = dir ? [assertAllowed(dir)] : ALLOWED_DIRS;
    const results = [];
    for (const root of roots) await searchDir(root, q, results);
    return { ok: true, result: results.length ? results.join("\n") : "No matches found" };
  },

  async read_file({ path: p }) {
    const resolved = assertAllowed(p);
    const stat = await fs.stat(resolved);
    if (stat.size > 2_000_000) return { ok: false, error: "file too large to read" };
    const text = await fs.readFile(resolved, "utf8");
    return { ok: true, result: text.slice(0, 6000) + (text.length > 6000 ? "\n…(truncated)" : "") };
  },

  async system_info() {
    return {
      ok: true,
      result: [
        `Time: ${new Date().toString()}`,
        `OS: ${os.type()} ${os.release()} (${os.arch()})`,
        `Host: ${os.hostname()}`,
        `Uptime: ${Math.round(os.uptime() / 3600)}h`,
        `Free memory: ${Math.round(os.freemem() / 1e9)} / ${Math.round(os.totalmem() / 1e9)} GB`,
        `AYUS's allowed folders: ${ALLOWED_DIRS.join(" | ")}`,
      ].join("\n"),
    };
  },
};

export { ALLOWED_DIRS };
