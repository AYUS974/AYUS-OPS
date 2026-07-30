import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import "./Workflows.css";

/**
 * Workflow Automation — the "n8n layer" for AYUS. A workflow is a trigger
 * (manual / schedule / webhook) plus an ordered list of steps that run over
 * AYUS's own primitives. This page lists workflows, edits them in a builder,
 * runs them on demand, and replays each run's per-step log.
 */

function timeAgo(iso) {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

// The step palette — label, icon, and the config fields each step type edits.
const STEP_LIBRARY = {
  create_mission: {
    label: "Run a Mission",
    icon: "🛰",
    hint: "Kick the autonomous org at an objective.",
    fields: [{ key: "objective", label: "Objective", kind: "textarea", placeholder: "Research the top 5 competitors and write a brief" }],
  },
  llm: {
    label: "Ask the LLM",
    icon: "✦",
    hint: "Run a prompt; its text output feeds later steps as {{steps.<id>.output}}.",
    fields: [
      { key: "prompt", label: "Prompt", kind: "textarea", placeholder: "Summarise this: {{steps.s1.output}}" },
      { key: "system", label: "System (optional)", kind: "text", placeholder: "You are a concise analyst." },
    ],
  },
  propose_action: {
    label: "Propose to Approval Queue",
    icon: "✓",
    hint: "Drop a card into the human approval queue.",
    fields: [
      { key: "type", label: "Action type", kind: "text", placeholder: "manual_task" },
      { key: "title", label: "Title", kind: "text", placeholder: "Follow up with {{trigger.payload.name}}" },
      { key: "summary", label: "Summary", kind: "textarea", placeholder: "" },
      { key: "payload", label: "Payload (JSON)", kind: "json", placeholder: '{ "to": "x@y.com" }' },
    ],
  },
  notify: {
    label: "Send Notification",
    icon: "🔔",
    hint: "Telegram ping (or server console if not configured).",
    fields: [
      { key: "message", label: "Message", kind: "textarea", placeholder: "Workflow finished: {{steps.s1.output}}" },
      { key: "urgent", label: "Mark urgent", kind: "checkbox" },
    ],
  },
  http: {
    label: "HTTP Request",
    icon: "🌐",
    hint: "The escape hatch — call any external API.",
    fields: [
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      { key: "url", label: "URL", kind: "text", placeholder: "https://api.example.com/hook" },
      { key: "headers", label: "Headers (JSON)", kind: "json", placeholder: '{ "Authorization": "Bearer …" }' },
      { key: "body", label: "Body", kind: "textarea", placeholder: '{ "text": "{{steps.s1.output}}" }' },
    ],
  },
  delay: {
    label: "Wait",
    icon: "⏱",
    hint: "Pause before the next step (max 300s).",
    fields: [{ key: "seconds", label: "Seconds", kind: "number", placeholder: "30" }],
  },
};

const TRIGGER_LABEL = { manual: "Manual", schedule: "Schedule", event: "Webhook" };

function newStep(type) {
  const config = {};
  if (type === "http") config.method = "GET";
  return { id: "s" + Math.random().toString(36).slice(2, 7), type, name: STEP_LIBRARY[type].label, config };
}

function StatusPill({ status }) {
  const cls = status === "ok" ? "wf-ok" : status === "error" ? "wf-err" : status === "running" ? "wf-run" : "wf-idle";
  return <span className={`wf-pill ${cls}`}>{status || "—"}</span>;
}

/* ---------------- per-step config form ---------------- */
function StepConfig({ step, onChange }) {
  const lib = STEP_LIBRARY[step.type];
  const set = (key, value) => onChange({ ...step, config: { ...step.config, [key]: value } });

  return (
    <div className="wf-step-config">
      {lib.hint && <div className="wf-step-hint">{lib.hint}</div>}
      {lib.fields.map((f) => {
        const val = step.config?.[f.key];
        if (f.kind === "checkbox") {
          return (
            <label key={f.key} className="wf-check">
              <input type="checkbox" checked={Boolean(val)} onChange={(e) => set(f.key, e.target.checked)} />
              {f.label}
            </label>
          );
        }
        if (f.kind === "select") {
          return (
            <label key={f.key} className="wf-field">
              <span>{f.label}</span>
              <select value={val || f.options[0]} onChange={(e) => set(f.key, e.target.value)}>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          );
        }
        const isArea = f.kind === "textarea" || f.kind === "json";
        return (
          <label key={f.key} className="wf-field">
            <span>{f.label}</span>
            {isArea ? (
              <textarea
                rows={f.kind === "json" ? 3 : 5}
                value={val ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => set(f.key, e.target.value)}
              />
            ) : (
              <input
                type={f.kind === "number" ? "number" : "text"}
                value={val ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => set(f.key, f.kind === "number" ? e.target.value : e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

/* ---------------- run log ---------------- */
function RunLog({ runs }) {
  if (!runs?.length) return <div className="wf-empty-mini">No runs yet.</div>;
  return (
    <div className="wf-runs">
      {runs.map((r) => (
        <div className="wf-run" key={r.id}>
          <div className="wf-run-head">
            <StatusPill status={r.status} />
            <span className="wf-run-trigger">{r.trigger_type}</span>
            <span className="wf-run-when">{timeAgo(r.started_at)}</span>
          </div>
          {r.error && <div className="wf-run-error">{r.error}</div>}
          <div className="wf-run-steps">
            {(r.log || []).map((l, i) => (
              <div className={`wf-log-line ${l.status === "error" ? "is-err" : ""}`} key={i}>
                <span className="wf-log-dot" />
                <span className="wf-log-step">{l.step}</span>
                <span className="wf-log-msg" title={l.message}>{l.message}</span>
                <span className="wf-log-ms">{l.ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- editor ---------------- */
function Editor({ initial, onClose, onSaved, showToast }) {
  const [draft, setDraft] = useState(() => ({
    name: "",
    description: "",
    enabled: true,
    trigger: { type: "manual" },
    steps: [],
    ...initial,
  }));
  const [runs, setRuns] = useState(initial?.id ? null : []);
  const [saving, setSaving] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [adding, setAdding] = useState(false);

  const isEdit = Boolean(initial?.id);

  useEffect(() => {
    if (!isEdit) return;
    api(`/workflows/${initial.id}/runs`).then((d) => setRuns(d.runs || [])).catch(() => setRuns([]));
  }, [isEdit, initial?.id]);

  const setTrigger = (patch) => setDraft((d) => ({ ...d, trigger: { ...d.trigger, ...patch } }));
  const updateStep = (idx, next) => setDraft((d) => ({ ...d, steps: d.steps.map((s, i) => (i === idx ? next : s)) }));
  const removeStep = (idx) => setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== idx) }));
  const moveStep = (idx, dir) =>
    setDraft((d) => {
      const j = idx + dir;
      if (j < 0 || j >= d.steps.length) return d;
      const steps = d.steps.slice();
      [steps[idx], steps[j]] = [steps[j], steps[idx]];
      return { ...d, steps };
    });
  const addStep = (type) => {
    setDraft((d) => ({ ...d, steps: [...d.steps, newStep(type)] }));
    setAdding(false);
  };

  async function save() {
    if (!draft.name.trim()) return showToast?.("Name is required", "err");
    setSaving(true);
    try {
      // JSON-typed fields are edited as text; parse them before sending.
      const steps = draft.steps.map((s) => {
        const config = { ...s.config };
        for (const f of STEP_LIBRARY[s.type].fields) {
          if (f.kind === "json" && typeof config[f.key] === "string" && config[f.key].trim()) {
            try { config[f.key] = JSON.parse(config[f.key]); }
            catch { throw new Error(`${s.name}: "${f.label}" is not valid JSON`); }
          }
          if (f.kind === "number" && config[f.key] != null) config[f.key] = Number(config[f.key]);
        }
        return { ...s, config };
      });
      const body = { ...draft, steps };
      const saved = isEdit
        ? await api(`/workflows/${initial.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/workflows", { method: "POST", body: JSON.stringify(body) });
      showToast?.(isEdit ? "Workflow saved ✓" : "Workflow created ✓", "ok");
      onSaved?.(saved.workflow);
    } catch (e) {
      showToast?.(String(e.message || e), "err");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    if (!isEdit) return showToast?.("Save the workflow first, then run it.", "warn");
    setRunningNow(true);
    try {
      const res = await api(`/workflows/${initial.id}/run`, { method: "POST", body: JSON.stringify({}) });
      showToast?.(res.ok ? "Ran ✓" : `Ran with an error: ${res.error}`, res.ok ? "ok" : "err");
      const d = await api(`/workflows/${initial.id}/runs`);
      setRuns(d.runs || []);
    } catch (e) {
      showToast?.(String(e.message || e), "err");
    } finally {
      setRunningNow(false);
    }
  }

  const webhookUrl = draft.trigger?.token ? `${window.location.origin}/api/workflows/hook/${draft.trigger.token}` : null;

  return (
    <div className="wf-editor-wrap">
      <div className="wf-editor-backdrop" onClick={onClose} />
      <div className="wf-editor">
        <div className="wf-editor-head">
          <input
            className="wf-name-input"
            placeholder="Workflow name"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <div className="wf-editor-head-actions">
            <label className="wf-check">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} />
              Enabled
            </label>
            <button className="wf-btn ghost" onClick={onClose}>Close</button>
            {isEdit && <button className="wf-btn" disabled={runningNow} onClick={runNow}>{runningNow ? "Running…" : "▶ Run now"}</button>}
            <button className="wf-btn primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>

        <input
          className="wf-desc-input"
          placeholder="Short description (optional)"
          value={draft.description || ""}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
        />

        {/* Trigger */}
        <div className="wf-section">
          <div className="wf-section-title">Trigger</div>
          <div className="wf-trigger-tabs">
            {["manual", "schedule", "event"].map((t) => (
              <button key={t} className={`wf-trigger-tab ${draft.trigger.type === t ? "on" : ""}`} onClick={() => setTrigger({ type: t })}>
                {TRIGGER_LABEL[t]}
              </button>
            ))}
          </div>
          {draft.trigger.type === "schedule" && (
            <label className="wf-field">
              <span>Cron expression <span className="wf-muted">(min hour day month weekday)</span></span>
              <input
                type="text"
                placeholder="0 9 * * *  (every day at 9am)"
                value={draft.trigger.cron || ""}
                onChange={(e) => setTrigger({ cron: e.target.value })}
              />
            </label>
          )}
          {draft.trigger.type === "event" && (
            <div className="wf-webhook">
              {webhookUrl ? (
                <>
                  <div className="wf-muted">POST here to fire this workflow (body → trigger payload):</div>
                  <code className="wf-webhook-url">{webhookUrl}</code>
                </>
              ) : (
                <div className="wf-muted">Save the workflow to generate its webhook URL.</div>
              )}
            </div>
          )}
          {draft.trigger.type === "manual" && <div className="wf-muted">Fires only when you hit “Run now”.</div>}
        </div>

        {/* Steps */}
        <div className="wf-section">
          <div className="wf-section-title">Steps <span className="wf-muted">run top to bottom</span></div>
          {draft.steps.length === 0 && <div className="wf-empty-mini">No steps yet — add one below.</div>}
          <div className="wf-steps">
            {draft.steps.map((step, idx) => (
              <div className="wf-step" key={step.id}>
                <div className="wf-step-head">
                  <span className="wf-step-icon">{STEP_LIBRARY[step.type].icon}</span>
                  <span className="wf-step-num">{idx + 1}</span>
                  <input
                    className="wf-step-name"
                    value={step.name}
                    onChange={(e) => updateStep(idx, { ...step, name: e.target.value })}
                  />
                  <span className="wf-step-type">{step.type}</span>
                  <div className="wf-step-controls">
                    <button className="wf-icon-btn" title="Move up" disabled={idx === 0} onClick={() => moveStep(idx, -1)}>↑</button>
                    <button className="wf-icon-btn" title="Move down" disabled={idx === draft.steps.length - 1} onClick={() => moveStep(idx, 1)}>↓</button>
                    <button className="wf-icon-btn danger" title="Remove" onClick={() => removeStep(idx)}>✕</button>
                  </div>
                </div>
                <StepConfig step={step} onChange={(next) => updateStep(idx, next)} />
              </div>
            ))}
          </div>

          {adding ? (
            <div className="wf-palette">
              {Object.entries(STEP_LIBRARY).map(([type, lib]) => (
                <button key={type} className="wf-palette-item" onClick={() => addStep(type)}>
                  <span className="wf-step-icon">{lib.icon}</span>
                  <span>{lib.label}</span>
                </button>
              ))}
              <button className="wf-btn ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          ) : (
            <button className="wf-add-step" onClick={() => setAdding(true)}>+ Add step</button>
          )}
        </div>

        {/* Runs */}
        {isEdit && (
          <div className="wf-section">
            <div className="wf-section-title">Recent runs</div>
            {runs == null ? <div className="wf-skel" /> : <RunLog runs={runs} />}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- page ---------------- */
export default function Workflows({ showToast }) {
  const [workflows, setWorkflows] = useState(null);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(null); // workflow object | {} for new | null

  const load = useCallback(() => {
    setErr("");
    api("/workflows")
      .then((d) => setWorkflows(d.workflows || []))
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(wf) {
    try {
      await api(`/workflows/${wf.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !wf.enabled }) });
      load();
    } catch (e) {
      showToast?.(String(e.message || e), "err");
    }
  }

  async function runNow(wf) {
    showToast?.(`Running “${wf.name}”…`, "warn");
    try {
      const res = await api(`/workflows/${wf.id}/run`, { method: "POST", body: JSON.stringify({}) });
      showToast?.(res.ok ? `“${wf.name}” ran ✓` : `Ran with an error: ${res.error}`, res.ok ? "ok" : "err");
      load();
    } catch (e) {
      showToast?.(String(e.message || e), "err");
    }
  }

  async function remove(wf) {
    if (!window.confirm(`Delete workflow “${wf.name}”? This can't be undone.`)) return;
    try {
      await api(`/workflows/${wf.id}`, { method: "DELETE" });
      showToast?.("Workflow deleted", "warn");
      load();
    } catch (e) {
      showToast?.(String(e.message || e), "err");
    }
  }

  const count = workflows?.length ?? null;

  return (
    <div className="wf">
      <div className="wf-head">
        <div>
          <h2 className="wf-title">Workflows</h2>
          <div className="wf-sub">
            {count == null ? "—" : `${count} workflow${count === 1 ? "" : "s"}`} · automate AYUS on a trigger
          </div>
        </div>
        <button className="wf-btn primary" onClick={() => setEditing({})}>+ New workflow</button>
      </div>

      {err && <div className="wf-error">{err}</div>}

      {workflows == null ? (
        <div className="wf-grid">
          <div className="wf-skel" style={{ height: 120 }} />
          <div className="wf-skel" style={{ height: 120 }} />
          <div className="wf-skel" style={{ height: 120 }} />
        </div>
      ) : workflows.length === 0 ? (
        <div className="wf-empty">
          No workflows yet.
          <div className="wf-hint">
            Build one that runs a research mission every morning, forwards a webhook to the approval queue,
            or pings you on Telegram — trigger + steps, no code.
          </div>
        </div>
      ) : (
        <div className="wf-grid">
          {workflows.map((wf) => (
            <div className={`wf-card ${wf.enabled ? "" : "is-off"}`} key={wf.id}>
              <div className="wf-card-top">
                <span className="wf-trigger-badge">{TRIGGER_LABEL[wf.trigger?.type] || "Manual"}</span>
                <StatusPill status={wf.last_status} />
                <label className="wf-switch" title={wf.enabled ? "Enabled" : "Disabled"}>
                  <input type="checkbox" checked={wf.enabled} onChange={() => toggle(wf)} />
                  <span className="wf-switch-slider" />
                </label>
              </div>
              <h3 className="wf-card-name" onClick={() => setEditing(wf)}>{wf.name}</h3>
              {wf.description && <p className="wf-card-desc">{wf.description}</p>}
              <div className="wf-card-meta">
                <span>{(wf.steps || []).length} step{(wf.steps || []).length === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>{wf.run_count || 0} run{wf.run_count === 1 ? "" : "s"}</span>
                <span>·</span>
                <span>last {timeAgo(wf.last_run_at)}</span>
              </div>
              <div className="wf-card-actions">
                <button className="wf-btn" onClick={() => runNow(wf)}>▶ Run</button>
                <button className="wf-btn ghost" onClick={() => setEditing(wf)}>Edit</button>
                <button className="wf-btn ghost danger" onClick={() => remove(wf)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Editor
          initial={editing}
          showToast={showToast}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
