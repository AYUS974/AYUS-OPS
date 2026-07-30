import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { renderMarkdown, escapeHtml } from "../lib/markdown.js";
import "./Docs.css";

// The vault mirrors repo docs into F:\ANISH\Docs, grouped by the folder the
// repo lives in. Same colour assignment the Knowledge Vault graph uses, so a
// project reads the same in both places.
const GROUP_TONE = {
  BERAM: "d-t-ember",
  AYUS: "d-t-cyan",
  Anish: "d-t-gold",
};

function groupTone(group = "") {
  const key = Object.keys(GROUP_TONE).find((k) => group.toLowerCase().includes(k.toLowerCase()));
  return key ? GROUP_TONE[key] : "d-t-muted";
}

function readTime(words) {
  return Math.max(1, Math.round(words / 220)) + " min";
}

export default function Docs({ showToast }) {
  const [catalog, setCatalog] = useState(null);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);   // null = not searching
  const [openProject, setOpenProject] = useState(null);
  const [openDoc, setOpenDoc] = useState(null);   // { project, rel, title, words, updated }
  const [body, setBody] = useState(null);         // markdown string | null while loading
  const [expanded, setExpanded] = useState({});   // sidebar disclosure state

  const bodyCache = useRef(new Map());
  const readerRef = useRef(null);
  const searchRef = useRef(null);

  // ---------- catalog ----------
  useEffect(() => {
    api("/vault/docs")
      .then(setCatalog)
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  const byProject = useMemo(() => {
    const map = {};
    (catalog?.docs || []).forEach((d) => {
      (map[d.project] = map[d.project] || []).push(d);
    });
    return map;
  }, [catalog]);

  // ---------- search (server-side, debounced) ----------
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api(`/vault/docs/search?q=${encodeURIComponent(q)}`)
        .then((d) => setResults(d.hits || []))
        .catch((e) => setErr(String(e.message || e)));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  // ---------- open a document ----------
  const openDocument = useCallback(
    async (doc) => {
      setOpenDoc(doc);
      setOpenProject(doc.project);
      setExpanded((s) => ({ ...s, [doc.project]: true }));

      const key = doc.project + "/" + doc.rel;
      if (bodyCache.current.has(key)) {
        setBody(bodyCache.current.get(key));
        return;
      }
      setBody(null);
      try {
        const d = await api(`/vault/doc?p=${encodeURIComponent(doc.project)}&r=${encodeURIComponent(doc.rel)}`);
        bodyCache.current.set(key, d.body);
        setBody(d.body);
      } catch (e) {
        setBody("");
        setErr(String(e.message || e));
        showToast?.("Could not open that document", "error");
      }
    },
    [showToast]
  );

  useEffect(() => {
    if (readerRef.current) readerRef.current.scrollTop = 0;
  }, [openDoc, body]);

  // "/" focuses search from anywhere on the page
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && e.target !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && query) {
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query]);

  const rendered = useMemo(() => (body ? renderMarkdown(body) : null), [body]);

  const goHome = () => {
    setOpenDoc(null);
    setOpenProject(null);
    setQuery("");
  };

  // ---------- states ----------
  if (err && !catalog) {
    return (
      <div className="d-wrap">
        <div className="d-empty">
          Could not load the documentation library.
          <div className="hint">{err}</div>
        </div>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="d-wrap">
        <div className="d-empty mono muted">Reading the vault…</div>
      </div>
    );
  }

  const { projects, totals } = catalog;
  const maxFiles = Math.max(1, ...projects.map((p) => p.files));
  const ordered = [...projects].sort((a, b) => (b.commit || b.updated).localeCompare(a.commit || a.updated));

  return (
    <div className="d-wrap">
      {/* ---------- header ---------- */}
      <div className="d-head">
        <div>
          <div className="d-eyebrow">Second brain · documentation</div>
          <h2 className="d-title">Documentation</h2>
        </div>
        <div className="d-search">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every document…"
            spellCheck="false"
          />
          <span className="d-kbd">/</span>
        </div>
        <div className="d-totals mono">
          {totals.projects} projects · {totals.docs} docs · {Math.round(totals.words / 1000)}k words
        </div>
      </div>

      <div className="d-body">
        {/* ---------- sidebar ---------- */}
        <aside className="d-side">
          <button className={`d-side-home ${!openProject && !results ? "active" : ""}`} onClick={goHome}>
            All projects
          </button>
          {projects.map((p) => (
            <div key={p.name}>
              <button
                className={`d-proj ${openProject === p.name ? "open" : ""}`}
                onClick={() => {
                  setExpanded((s) => ({ ...s, [p.name]: !s[p.name] }));
                  setOpenProject(p.name);
                  setOpenDoc(null);
                  setQuery("");
                }}
              >
                <span className={`d-caret ${expanded[p.name] ? "down" : ""}`}>▸</span>
                <span className="d-proj-name">{p.name}</span>
                <span className="d-proj-count mono">{p.files}</span>
              </button>
              {expanded[p.name] && (
                <div className="d-files">
                  {(byProject[p.name] || []).map((d) => (
                    <button
                      key={d.rel}
                      title={d.rel}
                      className={`d-file ${openDoc?.project === d.project && openDoc?.rel === d.rel ? "active" : ""}`}
                      onClick={() => openDocument(d)}
                    >
                      {d.rel}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </aside>

        {/* ---------- main ---------- */}
        <div className="d-main" ref={readerRef}>
          {/* search results */}
          {results && (
            <div className="d-pad">
              <div className="d-eyebrow">Search</div>
              <h3 className="d-h3">
                {results.length} result{results.length === 1 ? "" : "s"} for “{query.trim()}”
              </h3>
              {results.length === 0 ? (
                <div className="d-empty">Nothing matched. Try a shorter word.</div>
              ) : (
                results.map((h) => (
                  <button
                    key={h.project + h.rel}
                    className="d-hit"
                    onClick={() => {
                      setQuery("");
                      openDocument(h);
                    }}
                  >
                    <div className="d-hit-title">{h.title}</div>
                    <div className="d-hit-path mono">
                      {h.project} / {h.rel}
                    </div>
                    <div
                      className="d-hit-snip"
                      dangerouslySetInnerHTML={{
                        __html: escapeHtml(h.snippet).replace(
                          new RegExp("(" + query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"),
                          "<mark>$1</mark>"
                        ),
                      }}
                    />
                  </button>
                ))
              )}
            </div>
          )}

          {/* reader */}
          {!results && openDoc && (
            <div className="d-pad d-reader">
              <div>
                <div className="d-crumb mono">
                  <button onClick={goHome}>Projects</button> /{" "}
                  <button
                    onClick={() => {
                      setOpenDoc(null);
                      setOpenProject(openDoc.project);
                    }}
                  >
                    {openDoc.project}
                  </button>{" "}
                  / {openDoc.rel}
                </div>
                <h3 className="d-h3">{openDoc.title}</h3>
                <div className="d-meta mono">
                  {readTime(openDoc.words)} · {openDoc.words.toLocaleString()} words · updated {openDoc.updated}
                </div>
                {body === null ? (
                  <div className="d-empty mono muted">Loading…</div>
                ) : (
                  <div className="d-md" dangerouslySetInnerHTML={{ __html: rendered?.html || "" }} />
                )}
              </div>
              {rendered?.toc?.length > 0 && (
                <div className="d-toc">
                  <div className="d-toc-head mono">On this page</div>
                  {rendered.toc.map((t, i) => (
                    <a
                      key={t.id + i}
                      href={`#${t.id}`}
                      className={t.level === 3 ? "lvl3" : ""}
                      onClick={(e) => {
                        e.preventDefault();
                        readerRef.current?.querySelector(`#${CSS.escape(t.id)}`)?.scrollIntoView({
                          behavior: "smooth",
                          block: "start",
                        });
                      }}
                    >
                      {t.text}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* one project's documents */}
          {!results && !openDoc && openProject && (
            <div className="d-pad">
              <div className="d-crumb mono">
                <button onClick={goHome}>Projects</button> / {openProject}
              </div>
              <h3 className="d-h3">{openProject}</h3>
              {(() => {
                const p = projects.find((x) => x.name === openProject);
                if (!p) return null;
                return (
                  <div className="d-meta mono">
                    {[p.group, p.stack].filter(Boolean).join(" · ")}
                    {p.group || p.stack ? " · " : ""}
                    {p.files} documents · {readTime(p.words)} to read
                    {p.remote ? (
                      <>
                        {" · "}
                        <a href={p.remote} target="_blank" rel="noopener">
                          repo
                        </a>
                      </>
                    ) : (
                      <span className="d-warn"> · local only, no remote</span>
                    )}
                  </div>
                );
              })()}
              <div className="d-grid">
                {(byProject[openProject] || []).map((d) => (
                  <button key={d.rel} className="d-card" onClick={() => openDocument(d)}>
                    <div className="d-card-name">{d.title}</div>
                    <div className="d-card-sub mono">{d.rel}</div>
                    <div className="d-card-sub mono">
                      {readTime(d.words)} · {d.updated}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* landing */}
          {!results && !openDoc && !openProject && (
            <div className="d-pad">
              <div className="d-stats">
                <div className="d-stat">
                  <div className="v mono">{totals.projects}</div>
                  <div className="k">Projects</div>
                </div>
                <div className="d-stat">
                  <div className="v mono">{totals.docs}</div>
                  <div className="k">Documents</div>
                </div>
                <div className="d-stat">
                  <div className="v mono">{Math.round(totals.words / 1000)}k</div>
                  <div className="k">Words</div>
                </div>
                <div className="d-stat">
                  <div className="v mono">{Math.round(totals.words / 220 / 60)}h</div>
                  <div className="k">To read it all</div>
                </div>
              </div>

              <div className="d-grid">
                {ordered.map((p) => (
                  <button
                    key={p.name}
                    className="d-card"
                    onClick={() => {
                      setOpenProject(p.name);
                      setExpanded((s) => ({ ...s, [p.name]: true }));
                    }}
                  >
                    <div className="d-card-name">{p.name}</div>
                    <div className="d-tags">
                      {p.group && (
                        <span className={`d-tag ${groupTone(p.group)}`}>{p.group.replace(/ Projects$/, "")}</span>
                      )}
                      {p.stack && <span className="d-tag d-t-muted">{p.stack}</span>}
                      {!p.remote && <span className="d-tag d-t-ember">local only</span>}
                    </div>
                    <div className="d-bar">
                      <i style={{ width: Math.round((p.files / maxFiles) * 100) + "%" }} />
                    </div>
                    <div className="d-card-sub mono">
                      {p.files} docs · {readTime(p.words)} · {p.commit || p.updated}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
