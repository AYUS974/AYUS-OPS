import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { renderMarkdown } from "../lib/markdown.js";
import "./Notes.css";

const SOURCE_LABEL = { me: "you", ayus: "AYUS", research: "Arjun" };
const EMPTY = { id: null, title: "", body: "", project: "", tags: "" };

function when(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  if (mins < 1440) return Math.floor(mins / 60) + "h ago";
  return new Date(iso).toLocaleDateString();
}

export default function Notes({ showToast }) {
  const [notes, setNotes] = useState(null);
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(""); // "" = all
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null); // note being read
  const [edit, setEdit] = useState(null); // { ...EMPTY } while composing
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (project) params.set("project", project);
    if (q.trim()) params.set("q", q.trim());
    api(`/notes?${params}`)
      .then((d) => {
        setNotes(d.notes || []);
        setProjects(d.projects || []);
      })
      .catch((e) => setErr(String(e.message || e)));
  }, [project, q]);

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const body = { ...edit, tags: edit.tags.split(",").map((t) => t.trim()).filter(Boolean) };
      const { note } = await api("/notes", { method: "POST", body: JSON.stringify(body) });
      showToast?.("Note saved.", "ok");
      setEdit(null);
      setOpen(note);
      load();
    } catch (e2) {
      setErr(String(e2.message || e2));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (note) => {
    if (!confirm(`Delete “${note.title}”?`)) return;
    try {
      await api(`/notes/${note.id}`, { method: "DELETE" });
      if (open?.id === note.id) setOpen(null);
      load();
    } catch (e) {
      showToast?.(String(e.message || e), "err");
    }
  };

  return (
    <div className="nt">
      <div className="nt-head">
        <div>
          <h2 className="nt-title">Notes</h2>
          <div className="nt-sub">
            {notes == null ? "—" : `${notes.length} note${notes.length === 1 ? "" : "s"}`}
            {project ? ` in ${project}` : ""} · AYUS writes here too
          </div>
        </div>
        <div className="nt-head-actions">
          <input className="nt-search" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="nt-btn" onClick={() => { setEdit({ ...EMPTY, project }); setOpen(null); }}>＋ New note</button>
        </div>
      </div>

      {err && <div className="nt-error">{err}</div>}

      <div className="nt-projects">
        <button className={`nt-chip ${!project ? "is-on" : ""}`} onClick={() => setProject("")}>All</button>
        {projects.map((p) => (
          <button key={p} className={`nt-chip ${project === p ? "is-on" : ""}`} onClick={() => setProject(p)}>{p}</button>
        ))}
      </div>

      <div className="nt-cols">
        <section className="nt-list">
          {notes == null ? (
            <div className="nt-skel" />
          ) : notes.length === 0 ? (
            <div className="nt-empty">
              {q || project ? "Nothing matches that." : "No notes yet."}
              <div className="nt-hint">Write one here, or just tell AYUS “ye note kar lo” while you work — research reports land here automatically.</div>
            </div>
          ) : (
            notes.map((n) => (
              <button key={n.id} className={`nt-card ${open?.id === n.id ? "is-open" : ""}`} onClick={() => { setOpen(n); setEdit(null); }}>
                <div className="nt-card-top">
                  <span className="nt-card-title">{n.title}</span>
                  <span className={`nt-src nt-src-${n.source}`}>{SOURCE_LABEL[n.source] || n.source}</span>
                </div>
                <div className="nt-card-body">{n.body.replace(/[#*`>_-]/g, " ").slice(0, 140)}</div>
                <div className="nt-card-foot">
                  {n.project && <span className="nt-tag">{n.project}</span>}
                  {(n.tags || []).map((t) => <span key={t} className="nt-tag nt-tag-soft">{t}</span>)}
                  <span className="nt-when">{when(n.updated_at)}</span>
                </div>
              </button>
            ))
          )}
        </section>

        <section className="nt-panel">
          {edit ? (
            <form className="nt-form" onSubmit={save}>
              <div className="nt-panel-title">{edit.id ? "Edit note" : "New note"}</div>
              <input className="nt-input" placeholder="Title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} required autoFocus />
              <div className="nt-row2">
                <input className="nt-input" placeholder="Project (e.g. utms-native-app)" value={edit.project} onChange={(e) => setEdit({ ...edit, project: e.target.value })} list="nt-projects" />
                <input className="nt-input" placeholder="tags, comma separated" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} />
              </div>
              <datalist id="nt-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
              <textarea className="nt-input nt-area" placeholder="Markdown supported…" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              <div className="nt-actions">
                <button className="nt-btn" type="submit" disabled={saving}>{saving ? "Saving…" : "Save note"}</button>
                <button className="nt-btn nt-btn-ghost" type="button" onClick={() => setEdit(null)}>Cancel</button>
              </div>
            </form>
          ) : open ? (
            <div className="nt-read">
              <div className="nt-read-head">
                <h3>{open.title}</h3>
                <div className="nt-read-actions">
                  <button className="nt-icon" title="Edit" onClick={() => setEdit({ id: open.id, title: open.title, body: open.body, project: open.project || "", tags: (open.tags || []).join(", ") })}>✎</button>
                  <button className="nt-icon nt-icon-danger" title="Delete" onClick={() => remove(open)}>✕</button>
                </div>
              </div>
              <div className="nt-read-meta">
                {open.project && <span className="nt-tag">{open.project}</span>}
                <span className={`nt-src nt-src-${open.source}`}>{SOURCE_LABEL[open.source] || open.source}</span>
                <span className="nt-when">updated {when(open.updated_at)}</span>
              </div>
              <div className="nt-read-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(open.body) }} />
            </div>
          ) : (
            <div className="nt-empty">
              Pick a note to read it.
              <div className="nt-hint">Ask AYUS “X ke baare mein kya notes hai?” and it searches these too.</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
