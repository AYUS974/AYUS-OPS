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
// We only need to block double quotes and newlines, because the target is
// always wrapped in double quotes in execAsync (preventing any shell injection).
function cmdSafe(s) {
  if (/["\r\n]/.test(s)) throw new Error("input contains characters that are not allowed");
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

// Friendly app name → process image name, for closing apps with taskkill.
const APP_PROCESSES = {
  spotify: "Spotify.exe",
  whatsapp: "WhatsApp.exe",
  chrome: "chrome.exe",
  edge: "msedge.exe",
  notepad: "notepad.exe",
  calculator: "CalculatorApp.exe",
  vscode: "Code.exe",
  code: "Code.exe",
  vlc: "vlc.exe",
  word: "WINWORD.EXE",
  excel: "EXCEL.EXE",
  explorer: "explorer.exe",
  outlook: "OUTLOOK.EXE",
  teams: "ms-teams.exe",
  discord: "Discord.exe",
};

// Killing any of these would destabilise or crash Windows — always refuse.
const PROTECTED_PROCESSES = new Set([
  "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
  "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "fontdrvhost.exe",
  "ctfmon.exe", "sihost.exe",
]);

// Multimedia virtual key codes, sent via WScript.Shell.SendKeys.
const MEDIA_KEYS = { play_pause: 179, play: 179, pause: 179, next: 176, previous: 177, prev: 177, stop: 178 };

// Run a PowerShell one-liner. Callers build these from validated numbers/enums
// only — never from raw user text. windowsHide keeps the console hidden.
async function runPowerShell(script) {
  await execAsync(`powershell -NoProfile -WindowStyle Hidden -Command "${script}"`, { windowsHide: true });
}

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
    name: "close_app",
    description:
      "Close/quit a running application on the founder's laptop by name (e.g. 'spotify', 'chrome', 'whatsapp', or any process like 'notepad.exe'). Use when asked to close, quit, or kill an app.",
    parameters: {
      type: "object",
      properties: { app: { type: "string", description: "App or process name to close" } },
      required: ["app"],
    },
  },
  {
    name: "media_control",
    description:
      "Control whatever is playing media (Spotify, YouTube, VLC…): play/pause, skip to next or previous track, or stop. Works via the keyboard media keys.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["play_pause", "next", "previous", "stop"] },
      },
      required: ["action"],
    },
  },
  {
    name: "volume",
    description:
      "Adjust the system volume: 'mute' (toggles mute), 'up' or 'down' (~10% step), or 'set' to a specific level 0-100.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["mute", "up", "down", "set"] },
        level: { type: "integer", description: "Target volume 0-100, only for action='set'" },
      },
      required: ["action"],
    },
  },
  {
    name: "lock_screen",
    description: "Lock the founder's laptop screen (Win+L). Use when he says 'lock my laptop/screen'.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "power",
    description:
      "Power control for the laptop. Actions: 'sleep', 'shutdown', 'restart' (both schedule with a short cancelable delay), or 'cancel' to abort a pending shutdown/restart. Always confirm intent before shutdown/restart, and tell the founder he can say 'cancel' to stop it.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["sleep", "shutdown", "restart", "cancel"] },
        delaySeconds: { type: "integer", description: "Delay before shutdown/restart (default 20, max 300)" },
      },
      required: ["action"],
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

  async close_app({ app }) {
    const raw = String(app || "").toLowerCase().trim();
    if (!raw) return { ok: false, error: "which app?" };
    // Map a friendly name to its process, else accept a process name directly.
    let proc = APP_PROCESSES[raw] || (raw.endsWith(".exe") ? raw : `${raw}.exe`);
    if (!/^[a-z0-9 ._-]+$/i.test(proc)) return { ok: false, error: "invalid app/process name" };
    if (PROTECTED_PROCESSES.has(proc.toLowerCase())) {
      return { ok: false, error: `Refusing to close ${proc} — it's a critical system process.` };
    }
    try {
      await execAsync(`taskkill /IM "${proc}" /F`, { shell: "cmd.exe", windowsHide: true });
      return { ok: true, result: `Closed ${proc}` };
    } catch {
      // taskkill exits non-zero when nothing matched
      return { ok: false, error: `Couldn't close ${proc} — it may not be running.` };
    }
  },

  async media_control({ action }) {
    const code = MEDIA_KEYS[String(action || "").toLowerCase().trim()];
    if (!code) return { ok: false, error: `unknown media action "${action}"` };
    await runPowerShell(`(New-Object -ComObject WScript.Shell).SendKeys([char]${code})`);
    return { ok: true, result: `Media: ${action}` };
  },

  async volume({ action, level }) {
    const a = String(action || "").toLowerCase().trim();
    const w = "$w=New-Object -ComObject WScript.Shell;";
    let script;
    if (a === "mute" || a === "unmute") script = `${w}$w.SendKeys([char]173)`;
    else if (a === "up") script = `${w}1..5|%{$w.SendKeys([char]175)}`; // ~+10%
    else if (a === "down") script = `${w}1..5|%{$w.SendKeys([char]174)}`; // ~-10%
    else if (a === "set") {
      const n = Math.max(0, Math.min(100, parseInt(level, 10)));
      if (Number.isNaN(n)) return { ok: false, error: "level 0-100 required for 'set'" };
      // Floor to 0 (50 down-steps), then step up ~n/2 times (each key ≈ 2%).
      script = `${w}1..50|%{$w.SendKeys([char]174)};1..${Math.round(n / 2)}|%{$w.SendKeys([char]175)}`;
    } else {
      return { ok: false, error: "action must be mute | up | down | set" };
    }
    await runPowerShell(script);
    return { ok: true, result: `Volume: ${a}${a === "set" ? ` ${level}%` : ""}` };
  },

  async lock_screen() {
    await execAsync("rundll32.exe user32.dll,LockWorkStation", { windowsHide: true });
    return { ok: true, result: "Screen locked." };
  },

  async power({ action, delaySeconds }) {
    const a = String(action || "").toLowerCase().trim();
    const t = Math.max(0, Math.min(300, parseInt(delaySeconds, 10) || 20));
    if (a === "shutdown") {
      await execAsync(`shutdown /s /t ${t}`, { windowsHide: true });
      return { ok: true, result: `Shutting down in ${t}s — say "cancel" to abort.` };
    }
    if (a === "restart") {
      await execAsync(`shutdown /r /t ${t}`, { windowsHide: true });
      return { ok: true, result: `Restarting in ${t}s — say "cancel" to abort.` };
    }
    if (a === "cancel") {
      await execAsync("shutdown /a", { windowsHide: true }).catch(() => {});
      return { ok: true, result: "Cancelled any pending shutdown/restart." };
    }
    if (a === "sleep") {
      await execAsync("rundll32.exe powrprof.dll,SetSuspendState 0,1,0", { windowsHide: true });
      return { ok: true, result: "Going to sleep." };
    }
    return { ok: false, error: "action must be sleep | shutdown | restart | cancel" };
  },

  async spotify_play({ query }) {
    // Strip double quotes to prevent cmdSafe from rejecting valid music searches that contain quotes
    const cleanQuery = String(query || "").replace(/"/g, "").trim();
    const q = cmdSafe(cleanQuery).slice(0, 80);
    if (!q) return { ok: false, error: "empty query" };
    // Opens Spotify on the search. NOTE: there is no reliable way to auto-start a
    // SPECIFIC track from a URI/keypress — the Play key only resumes whatever was
    // last playing. True "play this exact song" needs the Spotify Web API (see
    // spotify.js / spotify_play_track), which requires a Premium account.
    await startTarget(`spotify:search:${encodeURIComponent(q)}`);
    return { ok: true, result: `Opened Spotify search for "${q}" — top result is one click from playing.` };
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
