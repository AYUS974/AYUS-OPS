import { useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import JSZip from "jszip";
import "./CodeWorkspace.css";

/**
 * CodeWorkspace — the in-browser IDE for a mission's code deliverable.
 *
 * Renders a file tree + Monaco editor + a live, sandboxed preview, the way
 * bolt.new / v0 / z.ai do. Edits are local to the session (so you can tweak and
 * re-run instantly); the whole project zips up for download. The mission's
 * result.files array drives it — see assembleCode() in src/lib/missions/engine.js.
 */

const LANG = {
  html: "html", htm: "html", css: "css", scss: "scss",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", json: "json", md: "markdown",
  py: "python", svg: "xml", xml: "xml", txt: "plaintext", yml: "yaml", yaml: "yaml",
};
const langOf = (path) => LANG[(path.split(".").pop() || "").toLowerCase()] || "plaintext";

// Sort so the entry point and styles/scripts read top-down like a real project.
const RANK = { html: 0, css: 1, js: 2 };
function sortFiles(files) {
  return [...files].sort((a, b) => {
    const ra = RANK[langOf(a.path)] ?? 9;
    const rb = RANK[langOf(b.path)] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.path.localeCompare(b.path);
  });
}

const ICON = { html: "◧", css: "✎", javascript: "{}", json: "{}", markdown: "¶" };
const iconOf = (path) => ICON[langOf(path)] || "•";

/** Assemble a single runnable HTML doc from the files, inlining local css/js. */
function buildPreview(files) {
  if (!files.length) {
    return "<!doctype html><body style='font-family:sans-serif;color:#888;padding:2rem'>No files to preview.</body>";
  }
  const byPath = new Map(files.map((f) => [f.path.replace(/^[./]+/, "").split(/[?#]/)[0], f.contents]));
  const htmlFile =
    files.find((f) => /(^|\/)index\.html?$/i.test(f.path)) || files.find((f) => /\.html?$/i.test(f.path));

  if (!htmlFile) {
    const js = files.find((f) => /\.js$/i.test(f.path));
    const css = files.find((f) => /\.css$/i.test(f.path));
    return (
      `<!doctype html><html><head><meta charset="utf-8">${css ? `<style>${css.contents}</style>` : ""}</head>` +
      `<body>${js ? `<script>${js.contents}<\/script>` : "<pre>No HTML entry point.</pre>"}</body></html>`
    );
  }

  let html = htmlFile.contents;
  // Inline <link rel="stylesheet" href="local.css">
  html = html.replace(/<link\b[^>]*?href=["']([^"']+)["'][^>]*>/gi, (tag, href) => {
    const css = byPath.get(href.replace(/^[./]+/, "").split(/[?#]/)[0]);
    return css != null ? `<style>\n${css}\n</style>` : tag;
  });
  // Inline <script src="local.js"></script>
  html = html.replace(/<script\b[^>]*?src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
    const js = byPath.get(src.replace(/^[./]+/, "").split(/[?#]/)[0]);
    return js != null ? `<script>\n${js}\n<\/script>` : tag;
  });
  return html;
}

export default function CodeWorkspace({ files: initialFiles, title, showToast }) {
  const [files, setFiles] = useState(() => sortFiles(initialFiles || []));
  const [activePath, setActivePath] = useState(() => sortFiles(initialFiles || [])[0]?.path || null);
  const [view, setView] = useState("split"); // split | code | preview
  const [runKey, setRunKey] = useState(0); // bump to force a preview reload
  const [zipping, setZipping] = useState(false);

  const active = files.find((f) => f.path === activePath) || files[0];
  const srcDoc = useMemo(() => buildPreview(files), [files, runKey]);
  const lastReset = useRef(initialFiles);

  // If a new mission's files arrive, reset the workspace to them.
  if (lastReset.current !== initialFiles) {
    lastReset.current = initialFiles;
    const sorted = sortFiles(initialFiles || []);
    setFiles(sorted);
    setActivePath(sorted[0]?.path || null);
  }

  function updateActive(value) {
    setFiles((fs) => fs.map((f) => (f.path === active.path ? { ...f, contents: value ?? "" } : f)));
  }

  async function downloadZip() {
    if (zipping || !files.length) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.path, f.contents));
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = ((title || "project").replace(/[^\w.-]+/g, "-").toLowerCase() || "project") + ".zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast?.("Project downloaded as ZIP ✓", "ok");
    } catch (e) {
      showToast?.("ZIP failed: " + e.message, "err");
    } finally {
      setZipping(false);
    }
  }

  function copyActive() {
    if (!active) return;
    navigator.clipboard?.writeText(active.contents).then(
      () => showToast?.(`Copied ${active.path}`, "ok"),
      () => showToast?.("Copy failed", "err")
    );
  }

  function openPreviewInTab() {
    const blob = new Blob([srcDoc], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  }

  if (!files.length) return <div className="cw-empty">No code files in this deliverable.</div>;

  return (
    <div className="cw">
      <div className="cw-toolbar">
        <div className="cw-views">
          <button className={`cw-vbtn ${view === "code" ? "on" : ""}`} onClick={() => setView("code")}>Code</button>
          <button className={`cw-vbtn ${view === "split" ? "on" : ""}`} onClick={() => setView("split")}>Split</button>
          <button className={`cw-vbtn ${view === "preview" ? "on" : ""}`} onClick={() => setView("preview")}>Preview</button>
        </div>
        <div className="cw-actions">
          <button className="cw-abtn" onClick={() => setRunKey((k) => k + 1)} title="Reload preview">↻ Run</button>
          <button className="cw-abtn" onClick={copyActive} title="Copy current file">Copy</button>
          <button className="cw-abtn" onClick={openPreviewInTab} title="Open preview in a new tab">⤢ Open</button>
          <button className="cw-abtn primary" disabled={zipping} onClick={downloadZip}>
            {zipping ? "Zipping…" : "↓ Download ZIP"}
          </button>
        </div>
      </div>

      <div className={`cw-body view-${view}`}>
        {view !== "preview" && (
          <>
            <aside className="cw-tree">
              {files.map((f) => (
                <button
                  key={f.path}
                  className={`cw-file ${f.path === active.path ? "active" : ""}`}
                  onClick={() => setActivePath(f.path)}
                  title={f.path}
                >
                  <span className="cw-file-icon">{iconOf(f.path)}</span>
                  <span className="cw-file-name">{f.path}</span>
                </button>
              ))}
            </aside>

            <div className="cw-editor">
              <Editor
                height="100%"
                theme="vs-dark"
                path={active.path}
                language={langOf(active.path)}
                value={active.contents}
                onChange={updateActive}
                loading={<div className="cw-loading">Loading editor…</div>}
                options={{
                  fontSize: 13,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 2,
                  automaticLayout: true,
                  padding: { top: 10 },
                }}
              />
            </div>
          </>
        )}

        {view !== "code" && (
          <div className="cw-preview">
            <iframe
              key={runKey}
              title="preview"
              className="cw-iframe"
              srcDoc={srcDoc}
              sandbox="allow-scripts allow-modals allow-popups"
            />
          </div>
        )}
      </div>
    </div>
  );
}
