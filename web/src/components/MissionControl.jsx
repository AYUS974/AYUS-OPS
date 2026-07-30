import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import CodeWorkspace from "./CodeWorkspace.jsx";
import "./MissionControl.css";

/* The org chart, mirrored from src/lib/missions/roles.js for display only. */
const ROLE_INFO = {
  founder:    { name: "Founder",   icon: "★", cls: "r-founder" },
  ceo:        { name: "Aria",      icon: "◈", cls: "r-ceo" },
  planner:    { name: "Atlas",     icon: "◇", cls: "r-planner" },
  researcher: { name: "Arjun",     icon: "A", cls: "r-researcher" },
  writer:     { name: "Kabir",     icon: "K", cls: "r-writer" },
  analyst:    { name: "Meera",     icon: "M", cls: "r-analyst" },
  engineer:   { name: "Vikram",    icon: "V", cls: "r-engineer" },
  designer:   { name: "Maya",      icon: "D", cls: "r-designer" },
  qa:         { name: "Quinn",     icon: "✓", cls: "r-qa" },
  reviewer:   { name: "Rohan",     icon: "⚖", cls: "r-reviewer" },
  system:     { name: "System",    icon: "•", cls: "r-system" },
};
const role = (id) => ROLE_INFO[id] || { name: id || "—", icon: "•", cls: "r-system" };

const PIPELINE = ["Scope", "Plan", "Build", "Assemble", "Review", "Deliver"];
const STAGE_INDEX = {
  queued: 0, scoping: 0, planning: 1, running: 2, assembling: 3,
  reviewing: 4, revising: 4, retrying: 0, completed: 5, failed: -1,
};
// Maps the real stage label the engine persists → pipeline position, so the
// tracker (incl. failures/stops) reflects exactly how far the org actually got.
const STAGE_BY_LABEL = {
  "Queued": 0, "Scope": 0, "Planning": 1, "Specialists working": 2,
  "CEO assembling": 3, "QA + Review": 4, "Revising": 4, "Delivered": 5,
};
// Polling stops on these; "stopping"/"retrying" stay live so the UI keeps watching.
const TERMINAL = new Set(["completed", "failed", "stopped"]);

const EXAMPLES = [
  "Research the AI voice-agent market and write a punchy LinkedIn post announcing AYUS Labs' new voice assistant.",
  "Draft a cold outreach email sequence (3 touches) to Indian D2C brands for our automation services.",
  "Write a technical design + landing-page copy for a PDF-tools SaaS we could ship in 2 weeks.",
];

function timeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? hrs + "h ago" : Math.floor(hrs / 24) + "d ago";
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/* Compact markdown → HTML for the deliverable (headings, bold, code, bullets). */
function renderMarkdown(text) {
  if (!text) return [];
  return text.split("\n").map((line, i) => {
    const t = line.trim();
    let html = line
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
    if (t === "---") return <hr key={i} />;
    if (t.startsWith("### ")) return <h4 key={i} dangerouslySetInnerHTML={{ __html: html.trim().slice(4) }} />;
    if (t.startsWith("## ")) return <h3 key={i} dangerouslySetInnerHTML={{ __html: html.trim().slice(3) }} />;
    if (t.startsWith("# ")) return <h2 key={i} dangerouslySetInnerHTML={{ __html: html.trim().slice(2) }} />;
    if (t.startsWith("- ") || t.startsWith("* ")) return <li key={i} dangerouslySetInnerHTML={{ __html: html.trim().slice(2) }} />;
    if (t === "") return <div key={i} style={{ height: 8 }} />;
    return <p key={i} dangerouslySetInnerHTML={{ __html: html }} />;
  });
}

export default function MissionControl({ showToast, onProposed }) {
  const [missions, setMissions] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [objective, setObjective] = useState("");
  const [launching, setLaunching] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [acting, setActing] = useState(false); // stop / resume in flight
  const [tick, setTick] = useState(0); // bump to restart detail polling after an action
  const detailRef = useRef(null);

  const loadList = useCallback(async () => {
    try {
      const { missions } = await api("/missions");
      setMissions(missions);
      // Auto-select the newest mission on first load.
      setSelectedId((cur) => cur ?? missions[0]?.id ?? null);
    } catch {
      setMissions((m) => m ?? []);
    }
  }, []);

  // Poll the list (so new missions + status pills stay fresh).
  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 15000);
    return () => clearInterval(t);
  }, [loadList]);

  // Poll the selected mission's detail — fast while it's live, stop when terminal.
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let alive = true;
    detailRef.current = selectedId;

    async function poll() {
      try {
        const d = await api(`/missions/${selectedId}`);
        if (!alive || detailRef.current !== selectedId) return;
        setDetail(d);
        if (TERMINAL.has(d.mission.status)) return; // stop polling once done
        setTimeout(poll, 4000);
      } catch {
        if (alive) setTimeout(poll, 8000);
      }
    }
    poll();
    return () => { alive = false; };
  }, [selectedId, tick]);

  async function launch(text) {
    const obj = (text ?? objective).trim();
    if (!obj || launching) return;
    setLaunching(true);
    try {
      const { mission } = await api("/missions", { method: "POST", body: JSON.stringify({ objective: obj }) });
      setObjective("");
      showToast?.("Mission launched — the org is on it 🛰️", "ok");
      await loadList();
      setSelectedId(mission.id);
    } catch (err) {
      showToast?.("Couldn't launch mission: " + err.message, "err");
    } finally {
      setLaunching(false);
    }
  }

  async function stopMission() {
    const m = detail?.mission;
    if (!m || acting) return;
    setActing(true);
    try {
      await api(`/missions/${m.id}/stop`, { method: "POST" });
      showToast?.("Stopping mission…", "ok");
      setTick((t) => t + 1); // keep polling so we see it settle to "stopped"
      loadList();
    } catch (err) {
      showToast?.("Couldn't stop: " + err.message, "err");
    } finally {
      setActing(false);
    }
  }

  async function resumeMission() {
    const m = detail?.mission;
    if (!m || acting) return;
    const retry = m.status === "failed";
    setActing(true);
    try {
      await api(`/missions/${m.id}/resume`, { method: "POST" });
      showToast?.(retry ? "Retrying mission…" : "Resuming mission…", "ok");
      setTick((t) => t + 1); // restart polling — it's live again
      loadList();
    } catch (err) {
      showToast?.((retry ? "Retry" : "Resume") + " failed: " + err.message, "err");
    } finally {
      setActing(false);
    }
  }

  async function sendToApprovals() {
    const m = detail?.mission;
    if (!m?.result?.deliverable || proposing) return;
    setProposing(true);
    try {
      await api("/actions/propose", {
        method: "POST",
        body: JSON.stringify({
          type: "manual_task",
          title: `Mission deliverable — ${m.result.title || m.objective.slice(0, 60)}`,
          summary: m.result.debrief || "Deliverable from a mission run.",
          payload: { tasks: [{ task_title: m.result.title || "Deliverable", task_description: m.result.deliverable.slice(0, 4000) }] },
        }),
      });
      showToast?.("Deliverable sent to the approval queue ✓", "ok");
      onProposed?.();
    } catch (err) {
      showToast?.("Failed to queue: " + err.message, "err");
    } finally {
      setProposing(false);
    }
  }

  function copyDeliverable() {
    const d = detail?.mission?.result?.deliverable;
    if (!d) return;
    navigator.clipboard?.writeText(d).then(
      () => showToast?.("Deliverable copied", "ok"),
      () => showToast?.("Copy failed", "err")
    );
  }

  return (
    <div className="mc">
      <div className="mc-header">
        <div>
          <div className="mc-title">Mission Control</div>
          <div className="mc-subtitle">
            Give one objective. The CEO scopes it, the Planner delegates, specialists build it,
            QA &amp; Review gate it — you get the deliverable.
          </div>
        </div>
      </div>

      {/* Launch */}
      <div className="mc-launch">
        <textarea
          className="mc-objective"
          placeholder="e.g. Research the AI agents market and write a LinkedIn post announcing our launch…"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch(); }}
          rows={2}
        />
        <button className="mc-launch-btn" disabled={!objective.trim() || launching} onClick={() => launch()}>
          {launching ? <span className="mc-spin" /> : "▶"} {launching ? "Launching…" : "Launch mission"}
        </button>
      </div>
      <div className="mc-examples">
        {EXAMPLES.map((ex, i) => (
          <button key={i} className="mc-example" onClick={() => launch(ex)} disabled={launching} title={ex}>
            {ex.length > 64 ? ex.slice(0, 64) + "…" : ex}
          </button>
        ))}
      </div>

      <div className="mc-body">
        {/* Mission list */}
        <aside className="mc-list">
          <div className="mc-list-label">Missions</div>
          {missions === null ? (
            <div className="mc-skeleton" />
          ) : missions.length === 0 ? (
            <div className="mc-empty-sm">No missions yet. Launch one above.</div>
          ) : (
            missions.map((m) => (
              <button
                key={m.id}
                className={`mc-list-item ${selectedId === m.id ? "active" : ""} st-${m.status}`}
                onClick={() => setSelectedId(m.id)}
              >
                <span className={`mc-pill st-${m.status}`}>{m.status}</span>
                <span className="mc-list-obj">{m.objective}</span>
                <span className="mc-list-time">{timeAgo(m.created_at)}</span>
              </button>
            ))
          )}
        </aside>

        {/* Detail */}
        <section className="mc-detail">
          {!detail ? (
            <div className="mc-empty">Select a mission, or launch a new one to watch the org work.</div>
          ) : (
            <MissionDetail
              detail={detail}
              onCopy={copyDeliverable}
              onSendToApprovals={sendToApprovals}
              onStop={stopMission}
              onResume={resumeMission}
              acting={acting}
              proposing={proposing}
              showToast={showToast}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function MissionDetail({ detail, onCopy, onSendToApprovals, onStop, onResume, acting, proposing, showToast }) {
  const { mission: m, tasks, events } = detail;
  const live = !TERMINAL.has(m.status);
  const completed = m.status === "completed";
  const failed = m.status === "failed";
  const stopped = m.status === "stopped";
  const stopping = m.status === "stopping";
  // Real position from the persisted stage label (falls back to status).
  const pos = STAGE_BY_LABEL[m.stage] ?? STAGE_INDEX[m.status] ?? 0;
  const criteria = m.plan?.success_criteria || [];

  const canStop = live && !stopping; // queued/scoping/.../retrying
  const canResume = failed || stopped;

  return (
    <>
      <div className="mc-d-head">
        <span className={`mc-pill lg st-${m.status}`}>
          {live && <span className="mc-live-dot" />}{m.status}
        </span>
        {m.deliverable_type && <span className="mc-type">{m.deliverable_type}</span>}
        {m.quality_score != null && <span className="mc-qa">QA {m.quality_score}/10</span>}
        <span className="mc-d-stage">{m.stage}</span>
        <div className="mc-d-actions">
          {stopping && <button className="mc-mini-btn" disabled>Stopping…</button>}
          {canStop && (
            <button className="mc-mini-btn danger" disabled={acting} onClick={onStop}>■ Stop</button>
          )}
          {canResume && (
            <button className="mc-mini-btn primary" disabled={acting} onClick={onResume}>
              ↻ {failed ? "Retry" : "Resume"}
            </button>
          )}
        </div>
      </div>
      <div className="mc-objective-text">{m.objective}</div>

      {/* Pipeline tracker — reflects the real stage the org reached */}
      <div className="mc-pipeline">
        {PIPELINE.map((label, i) => {
          const done = completed || i < pos;
          const isFailed = failed && i === pos;
          const isStopped = stopped && i === pos;
          const current = !completed && !failed && !stopped && i === pos;
          const cls = done ? "done" : isFailed ? "failed" : isStopped ? "stopped" : current ? "current" : "";
          
          let dotContent;
          if (done) {
            dotContent = (
              <svg viewBox="0 0 24 24" className="mc-dot-svg check" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            );
          } else if (isFailed) {
            dotContent = (
              <svg viewBox="0 0 24 24" className="mc-dot-svg cross" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            );
          } else if (isStopped) {
            dotContent = (
              <svg viewBox="0 0 24 24" className="mc-dot-svg stop" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            );
          } else {
            dotContent = i + 1;
          }

          return (
            <div key={label} className={`mc-stage ${cls}`}>
              <span className="mc-stage-dot">{dotContent}</span>
              <span className="mc-stage-label">{label}</span>
            </div>
          );
        })}
      </div>

      {m.error && <div className="mc-error">⚠ {m.error}</div>}

      {/* Success criteria */}
      {criteria.length > 0 && (
        <div className="mc-block">
          <div className="mc-block-title">Success criteria <span className="mc-by">— set by Aria (CEO)</span></div>
          <ul className="mc-criteria">{criteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </div>
      )}

      <div className="mc-two-col">
        {/* Task pipeline */}
        <div className="mc-block">
          <div className="mc-block-title">Specialist tasks <span className="mc-by">— delegated by Atlas (Planner)</span></div>
          {tasks.length === 0 ? (
            <div className="mc-empty-sm">{live ? "Planning…" : "No tasks."}</div>
          ) : (
            tasks.map((t) => <TaskRow key={t.id} task={t} />)
          )}
        </div>

        {/* A2A timeline */}
        <div className="mc-block">
          <div className="mc-block-title">Agent-to-agent timeline</div>
          <div className="mc-timeline-container">
            <div className="mc-timeline-line" />
            <div className="mc-timeline">
              {events.length === 0 ? (
                <div className="mc-empty-sm">No activity yet.</div>
              ) : (
                events.map((e) => <EventRow key={e.id} ev={e} />)
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Deliverable */}
      {m.result?.deliverable && (
        <div className="mc-block mc-deliverable">
          <div className="mc-block-title">
            Deliverable <span className="mc-by">— {m.result.title}</span>
            <div className="mc-deliv-actions">
              <button className="mc-mini-btn" onClick={onCopy}>Copy</button>
              <button className="mc-mini-btn primary" disabled={proposing} onClick={onSendToApprovals}>
                {proposing ? "Queuing…" : "Send to approvals"}
              </button>
            </div>
          </div>
          {m.result.debrief && <div className="mc-debrief">{m.result.debrief}</div>}
          {m.result.files?.length > 0 ? (
            <CodeWorkspace files={m.result.files} title={m.result.title} showToast={showToast} />
          ) : (
            <div className="mc-deliv-body">{renderMarkdown(m.result.deliverable)}</div>
          )}
        </div>
      )}
    </>
  );
}

function TaskRow({ task }) {
  const [open, setOpen] = useState(false);
  const r = role(task.role);
  const hasOutput = !!task.output;
  return (
    <div className={`mc-task st-${task.status} ${open ? "expanded" : ""}`}>
      <button 
        className={`mc-task-head ${hasOutput ? "has-output" : ""}`} 
        onClick={() => hasOutput && setOpen((o) => !o)}
      >
        <span className={`mc-avatar ${r.cls}`}>{r.icon}</span>
        <span className="mc-task-main">
          <span className="mc-task-title">{task.title}</span>
          <span className="mc-task-meta">
            {r.name}
            {task.depends_on?.length > 0 && <span className="mc-dep"> · needs {task.depends_on.join(", ")}</span>}
          </span>
        </span>
        <div className="mc-task-right">
          <span className={`mc-task-status st-${task.status}`}>
            {task.status === "running" ? <span className="mc-spin sm" /> : task.status}
          </span>
          {hasOutput && (
            <svg 
              className={`mc-chevron ${open ? "open" : ""}`} 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2.5"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </div>
      </button>
      {open && task.output && <div className="mc-task-output">{renderMarkdown(task.output)}</div>}
    </div>
  );
}

function EventRow({ ev }) {
  const from = role(ev.from_agent);
  const to = ev.to_agent ? role(ev.to_agent) : null;
  return (
    <div className={`mc-event k-${ev.kind}`}>
      <div className="mc-event-node">
        <span className="mc-event-dot" />
      </div>
      <span className="mc-event-time">{clock(ev.created_at)}</span>
      <div className="mc-event-flow">
        <span className={`mc-avatar xs ${from.cls}`} title={from.name}>{from.icon}</span>
        {to && (
          <span className="mc-arrow">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        )}
        {to && <span className={`mc-avatar xs ${to.cls}`} title={to.name}>{to.icon}</span>}
      </div>
      <span className="mc-event-msg">{ev.message}</span>
    </div>
  );
}
