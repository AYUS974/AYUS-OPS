// AYUS Desktop — a JARVIS-style Electron shell.
//
// It does NOT re-implement the app: it spawns the existing ayus-ops server
// (../src/index.js), which already serves the React UI + /api + the live-voice
// WebSocket on one port, then loads that origin in a window. Same-origin means
// every /api call, the Gemini Live socket, and mic access all work unchanged.
//
// JARVIS extras this shell adds: system tray, a global summon hotkey, always-on
// -top toggle, hide-to-tray (stays running), and auto-granted microphone.
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, session, shell, dialog, ipcMain, desktopCapturer, screen } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

// On a normal desktop the GPU is fine and gives the smoothest HUD, so leave it
// on by default. Set AYUS_DISABLE_GPU=1 for headless/VM/CI sessions that lack a
// usable GPU (or even the software-GL DLLs), where the GPU process crashes with
// "GPU process isn't usable".
if (process.env.AYUS_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("no-sandbox");
}

const ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(ROOT, "src", "index.js");
const PORT = process.env.AYUS_PORT || "3000";
const APP_URL = `http://127.0.0.1:${PORT}`;
// Summon/hide AYUS from anywhere. Override with AYUS_HOTKEY (Electron accelerator syntax).
const HOTKEY = process.env.AYUS_HOTKEY || "CommandOrControl+Shift+Space";
// Toggle the small always-on-top floating assistant pill (rides over other apps).
const OVERLAY_HOTKEY = process.env.AYUS_OVERLAY_HOTKEY || "CommandOrControl+Shift+A";

// Built after app-ready — some Electron modules aren't fully populated at load.
let ICON = null;
function makeIcon() {
  const iconPath = path.join(__dirname, "icon.png");
  const img = nativeImage.createFromPath(iconPath);
  if (!img.isEmpty()) return img;
  // Fallback: 1x1 placeholder if icon.png is missing.
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
  );
}

let serverProc = null;
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is the server already answering on PORT? (dev server, or a previous launch.)
function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/healthz`, (r) => {
      r.resume();
      resolve(r.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true;
    await sleep(300);
  }
  return false;
}

function startServer() {
  // Run the server with Electron's own binary acting as plain Node
  // (ELECTRON_RUN_AS_NODE) so a packaged app needs no separate Node install.
  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT, // so dotenv/config finds the repo-root .env
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(PORT), NODE_ENV: "production" },
    stdio: "inherit",
  });
  serverProc.on("exit", (code) => {
    serverProc = null;
    if (!quitting) console.error(`[desktop] server process exited (code ${code})`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#05070d",
    title: "AYUS",
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // the loaded app is trusted localhost, uses only browser APIs
    },
  });

  mainWindow.loadURL(APP_URL);

  // External links open in the real browser, not inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Closing the window hides to tray — AYUS stays alive and summonable.
  mainWindow.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function toggleWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// The floating assistant: a small frameless, transparent, always-on-top pill
// that rides above every other app (and fullscreen windows). It loads
// /overlay.html from the SAME origin as the main window, so it shares the login
// session in localStorage and hits /api with no CORS/token plumbing.
// Detect whether the GPU is usable. On Windows the GPU process often crashes
// with exit_code=-1073741515 (missing DLL). When that happens, transparent
// windows render as fully invisible/black — so we must fall back to an opaque
// frameless window with its own dark background.
let gpuOk = true;
app.on("gpu-process-crashed", () => {
  console.warn("[desktop] GPU process crashed — overlay will use opaque fallback");
  gpuOk = false;
});
app.on("child-process-gone", (_e, details) => {
  if (details.type === "GPU") {
    console.warn("[desktop] GPU child process gone — overlay will use opaque fallback");
    gpuOk = false;
  }
});

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 380;
  const H = 104;

  // Use transparency only if the GPU is alive; otherwise fall back to an opaque
  // dark window (rounded corners via CSS — the OS border-radius doesn't work
  // without compositing, but the card already has its own border-radius).
  const useTransparency = gpuOk;
  console.log(`[desktop] creating overlay (transparent=${useTransparency}, gpuOk=${gpuOk})`);

  overlayWindow = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 24,
    y: workArea.y + workArea.height - H - 24,
    frame: false,
    transparent: useTransparency,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    hasShadow: !useTransparency, // shadow looks good with opaque, bad with transparent
    backgroundColor: useTransparency ? "#00000000" : "#0a1422",
    show: false,
    title: "AYUS",
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 'screen-saver' level floats above fullscreen apps; also show across spaces.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadURL(`${APP_URL}/overlay.html`);
  // If the page 404s (web not built) the transparent window is invisible with
  // no clue — say so in the terminal instead of failing silently.
  overlayWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[desktop] overlay failed to load ${url}: ${desc} (${code}). Is the web app built? (npm run build)`);
  });
  overlayWindow.webContents.on("did-finish-load", () => {
    console.log("[desktop] overlay page loaded successfully");
  });
  overlayWindow.on("closed", () => (overlayWindow = null));
}

// Show the pill reliably. `ready-to-show` is flaky for transparent frameless
// windows on Windows, so callers wait on did-finish-load; here we just reveal
// and re-assert the top level (Windows can silently drop it).
function showOverlay() {
  if (!overlayWindow) return;
  overlayWindow.showInactive(); // showInactive avoids stealing focus from the user's app
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  console.log("[desktop] overlay shown");
}

function toggleOverlay() {
  if (!overlayWindow) {
    createOverlay();
    overlayWindow.webContents.once("did-finish-load", showOverlay);
    return;
  }
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
    console.log("[desktop] overlay hidden");
  } else {
    showOverlay();
  }
}

// Desktop powers exposed to the overlay via overlay-preload.js.
ipcMain.handle("capture-screen", async () => {
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(primary.size.width * scale),
      height: Math.round(primary.size.height * scale),
    },
  });
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  if (!src) throw new Error("no screen source available");
  return src.thumbnail.toDataURL();
});

// Grow/shrink the pill to fit its content, anchored to its bottom edge so it
// expands upward and respects wherever the user dragged it horizontally.
ipcMain.on("overlay-resize", (_e, height) => {
  if (!overlayWindow) return;
  const [w, curH] = overlayWindow.getSize();
  const [x, y] = overlayWindow.getPosition();
  const h = Math.max(88, Math.min(720, Math.round(height)));
  overlayWindow.setBounds({ x, y: y + curH - h, width: w, height: h });
});

ipcMain.on("overlay-hide", () => overlayWindow && overlayWindow.hide());

function buildTray() {
  tray = new Tray(ICON.isEmpty() ? ICON : ICON.resize({ width: 32, height: 32 }));
  tray.setToolTip("AYUS — click to summon");
  const menu = Menu.buildFromTemplate([
    { label: "Show / Hide AYUS", click: toggleWindow },
    { label: "Show / Hide floating assistant", click: toggleOverlay },
    {
      label: "Always on top",
      type: "checkbox",
      checked: false,
      click: (item) => mainWindow?.setAlwaysOnTop(item.checked),
    },
    { type: "separator" },
    { label: `Summon hotkey: ${HOTKEY}`, enabled: false },
    { label: `Assistant hotkey: ${OVERLAY_HOTKEY}`, enabled: false },
    { type: "separator" },
    {
      label: "Quit AYUS",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", toggleWindow);
}

// Auto-grant the microphone so voice works with no per-launch prompt loop.
function grantMic() {
  const s = session.defaultSession;
  const ok = (p) => p === "media" || p === "audioCapture" || p === "mediaKeySystem";
  s.setPermissionRequestHandler((_wc, permission, cb) => cb(ok(permission)));
  s.setPermissionCheckHandler((_wc, permission) => ok(permission));
}

// One instance only — a second launch just summons the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => toggleWindow());

  app.whenReady().then(async () => {
    ICON = makeIcon();
    grantMic();

    // Attach to an already-running server (e.g. `npm run dev`); else spawn our own.
    const alreadyUp = await ping();
    if (!alreadyUp) {
      startServer();
      const up = await waitForServer();
      if (!up) {
        dialog.showErrorBox(
          "AYUS failed to start",
          `The AYUS server didn't come up on ${APP_URL} within 30s.\n\n` +
            "Make sure the web app is built (run `npm run build` in the repo root) " +
            "and your .env is configured, then relaunch."
        );
      }
    }

    createWindow();
    buildTray();
    globalShortcut.register(HOTKEY, toggleWindow);
    globalShortcut.register(OVERLAY_HOTKEY, toggleOverlay);

    // Bring the floating assistant up on launch so it's there over other apps.
    // Wait briefly — the GPU crash event fires asynchronously and we need to know
    // if transparency is available BEFORE we create the overlay window.
    await sleep(800);
    console.log(`[desktop] launching overlay (gpuOk=${gpuOk})`);
    createOverlay();
    overlayWindow.webContents.once("did-finish-load", showOverlay);

    app.on("activate", () => {
      if (!mainWindow) createWindow();
      else toggleWindow();
    });
  });
}

// Stay resident in the tray after the window closes (JARVIS is always on).
app.on("window-all-closed", () => {
  /* intentionally do nothing — quit only from the tray menu */
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
});
