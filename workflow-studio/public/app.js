/* Workflow Studio — vanilla single-file frontend. Talks to /api. */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function apiFetch(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function timeAgo(iso) {
  if (!iso) return "never";
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function toast(msg, tone = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${tone}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ---------- step palette ----------
const STEP_LIBRARY = {
  template: { label: "Build Text", icon: "✎", hint: "Compose text from a template; output feeds later steps as {{steps.<id>.output}}.",
    fields: [{ key: "text", label: "Template", kind: "textarea", ph: "Hello {{trigger.payload.name}}" }] },
  set: { label: "Set Variable", icon: "≔", hint: "Store a value in {{vars.<key>}} for reuse below.",
    fields: [{ key: "key", label: "Variable name", kind: "text", ph: "greeting" }, { key: "value", label: "Value", kind: "textarea", ph: "Hello" }] },
  http: { label: "HTTP Request", icon: "🌐", hint: "Call any external API — the integration escape hatch.",
    fields: [
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      { key: "url", label: "URL", kind: "text", ph: "https://api.example.com" },
      { key: "headers", label: "Headers (JSON)", kind: "json", ph: '{ "Authorization": "Bearer …" }' },
      { key: "body", label: "Body", kind: "textarea", ph: '{ "text": "{{steps.s1.output}}" }' },
    ] },
  condition: { label: "Condition (gate)", icon: "◇", hint: "Stop the run unless the comparison passes.",
    fields: [
      { key: "left", label: "Left", kind: "text", ph: "{{steps.s1.output}}" },
      { key: "op", label: "Operator", kind: "select", options: ["==", "!=", "contains", ">", "<", "truthy"] },
      { key: "right", label: "Right", kind: "text", ph: "yes" },
    ] },
  delay: { label: "Wait", icon: "⏱", hint: "Pause before the next step (max 300s).",
    fields: [{ key: "seconds", label: "Seconds", kind: "number", ph: "30" }] },
  log: { label: "Log", icon: "🖹", hint: "Print a line to the server console + run log.",
    fields: [{ key: "message", label: "Message", kind: "textarea", ph: "Done: {{steps.s1.output}}" }] },
  llm: { label: "Ask the LLM", icon: "✦", hint: "Optional — needs ANTHROPIC_API_KEY in the server env.",
    fields: [{ key: "prompt", label: "Prompt", kind: "textarea", ph: "Summarise: {{steps.s1.output}}" }, { key: "model", label: "Model (optional)", kind: "text", ph: "claude-haiku-4-5-20251001" }] },
};
const TRIGGER_LABEL = { manual: "Manual", schedule: "Schedule", event: "Webhook" };

function newStep(type) {
  const config = {};
  if (type === "http") config.method = "GET";
  if (type === "condition") config.op = "==";
  return { id: "s" + Math.random().toString(36).slice(2, 7), type, name: STEP_LIBRARY[type].label, config };
}

// ---------- list view ----------
const state = { workflows: [] };

async function loadList() {
  try {
    const { workflows } = await apiFetch("/workflows");
    state.workflows = workflows;
    renderList();
  } catch (e) {
    $("#list").innerHTML = `<div class="empty">Couldn't load workflows.<div class="hint">${esc(e.message)}</div></div>`;
  }
}

function renderList() {
  const wfs = state.workflows;
  $("#count").textContent = `${wfs.length} workflow${wfs.length === 1 ? "" : "s"} · automate on a trigger, no code`;
  if (!wfs.length) {
    $("#list").innerHTML = `<div class="empty">No workflows yet.
      <div class="hint">Build one that polls an API every morning, forwards a webhook, or gates on a condition — trigger + steps, no code.</div></div>`;
    return;
  }
  $("#list").innerHTML = `<div class="grid">${wfs.map(cardHTML).join("")}</div>`;
}

function cardHTML(wf) {
  const trig = wf.trigger?.type || "manual";
  const steps = wf.steps?.length || 0;
  return `<div class="card ${wf.enabled ? "" : "off"}" data-id="${wf.id}">
    <div class="ctop">
      <span class="pill p-${trig}">${TRIGGER_LABEL[trig]}</span>
      <span class="pill p-${wf.last_status || "null"}">${wf.last_status || "—"}</span>
      <label class="switch"><input type="checkbox" data-act="toggle" ${wf.enabled ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <h3 data-act="edit">${esc(wf.name)}</h3>
    ${wf.description ? `<p class="desc">${esc(wf.description)}</p>` : ""}
    <div class="meta"><span>${steps} step${steps === 1 ? "" : "s"}</span><span>·</span><span>${wf.run_count || 0} runs</span><span>·</span><span>last ${timeAgo(wf.last_run_at)}</span></div>
    <div class="acts">
      <button data-act="run">▶ Run</button>
      <button class="ghost" data-act="edit">Edit</button>
      <button class="ghost danger" data-act="delete">Delete</button>
    </div>
  </div>`;
}

$("#list").addEventListener("click", async (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const wf = state.workflows.find((w) => w.id === card.dataset.id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!wf || !act) return;
  if (act === "edit") openEditor(wf);
  else if (act === "run") {
    toast(`Running “${wf.name}”…`, "warn");
    try { const r = await apiFetch(`/workflows/${wf.id}/run`, { method: "POST", body: "{}" }); toast(r.ok ? "Ran ✓" : `Ran: ${r.status}`, r.status === "error" ? "err" : "ok"); loadList(); }
    catch (err) { toast(err.message, "err"); }
  } else if (act === "delete") {
    if (!confirm(`Delete “${wf.name}”?`)) return;
    try { await apiFetch(`/workflows/${wf.id}`, { method: "DELETE" }); toast("Deleted", "warn"); loadList(); }
    catch (err) { toast(err.message, "err"); }
  } else if (act === "toggle") {
    try { await apiFetch(`/workflows/${wf.id}`, { method: "PUT", body: JSON.stringify({ ...wf, enabled: !wf.enabled }) }); loadList(); }
    catch (err) { toast(err.message, "err"); }
  }
});

$("#new-btn").addEventListener("click", () => openEditor(null));

// ---------- editor ----------
let draft = null;
let editingId = null;
let addingStep = false;

function openEditor(wf) {
  editingId = wf?.id || null;
  draft = wf
    ? JSON.parse(JSON.stringify(wf))
    : { name: "", description: "", enabled: true, trigger: { type: "manual" }, steps: [] };
  addingStep = false;
  renderEditor();
  if (editingId) loadRuns();
}

function closeEditor() {
  draft = null; editingId = null;
  $("#editor-root").innerHTML = "";
}

function fieldHTML(stepIdx, f, val) {
  const path = `data-step="${stepIdx}" data-cfg="${f.key}"`;
  if (f.kind === "checkbox") return `<label class="check"><input type="checkbox" ${path} ${val ? "checked" : ""}> ${f.label}</label>`;
  if (f.kind === "select") return `<label class="field"><span>${f.label}</span><select ${path}>${f.options.map((o) => `<option ${o === (val || f.options[0]) ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
  const isArea = f.kind === "textarea" || f.kind === "json";
  const control = isArea
    ? `<textarea rows="${f.kind === "json" ? 2 : 3}" ${path} placeholder="${esc(f.ph || "")}">${esc(val ?? "")}</textarea>`
    : `<input type="${f.kind === "number" ? "number" : "text"}" ${path} placeholder="${esc(f.ph || "")}" value="${esc(val ?? "")}">`;
  return `<label class="field"><span>${f.label}</span>${control}</label>`;
}

function stepHTML(step, idx, total) {
  const lib = STEP_LIBRARY[step.type];
  return `<div class="step" data-step="${idx}">
    <div class="shead">
      <span>${lib.icon}</span><span class="snum">${idx + 1}</span>
      <input class="sname" data-step="${idx}" data-name value="${esc(step.name)}">
      <span class="stype">${step.type}</span>
      <button class="icon-btn" data-step="${idx}" data-move="-1" ${idx === 0 ? "disabled" : ""}>↑</button>
      <button class="icon-btn" data-step="${idx}" data-move="1" ${idx === total - 1 ? "disabled" : ""}>↓</button>
      <button class="icon-btn danger" data-step="${idx}" data-remove>✕</button>
    </div>
    <div class="scfg">
      <div class="hint">${esc(lib.hint)}</div>
      ${lib.fields.map((f) => fieldHTML(idx, f, step.config?.[f.key])).join("")}
    </div>
  </div>`;
}

function renderEditor() {
  const t = draft.trigger.type;
  const token = draft.trigger?.token;
  const webhookUrl = token ? `${location.origin}/hook/${token}` : null;
  $("#editor-root").innerHTML = `
    <div class="backdrop" data-close></div>
    <div class="drawer">
      <div class="ehead">
        <input class="name-in" data-field="name" placeholder="Workflow name" value="${esc(draft.name)}">
        <div class="acts">
          <label class="check"><input type="checkbox" data-field="enabled" ${draft.enabled ? "checked" : ""}> Enabled</label>
          <button class="ghost" data-close>Close</button>
          ${editingId ? `<button data-runnow>▶ Run now</button>` : ""}
          <button class="primary" data-save>Save</button>
        </div>
      </div>
      <input class="desc-in" data-field="description" placeholder="Short description (optional)" value="${esc(draft.description || "")}">

      <div class="section">
        <div class="section-t">Trigger</div>
        <div class="ttabs">${["manual", "schedule", "event"].map((x) => `<button class="ttab ${t === x ? "on" : ""}" data-trigger="${x}">${TRIGGER_LABEL[x]}</button>`).join("")}</div>
        ${t === "schedule" ? `<label class="field"><span>Cron <span class="muted">(min hour day month weekday)</span></span><input data-field="cron" placeholder="0 9 * * *" value="${esc(draft.trigger.cron || "")}"></label>` : ""}
        ${t === "event" ? `<div class="webhook">${webhookUrl ? `<div class="muted">POST here to fire this workflow (body → trigger payload):</div><code>${esc(webhookUrl)}</code>` : `<div class="muted">Save to generate the webhook URL.</div>`}</div>` : ""}
        ${t === "manual" ? `<div class="muted">Fires only when you hit “Run now”.</div>` : ""}
      </div>

      <div class="section">
        <div class="section-t">Steps <span class="muted">run top to bottom</span></div>
        ${draft.steps.length ? "" : `<div class="muted">No steps yet — add one below.</div>`}
        <div class="steps">${draft.steps.map((s, i) => stepHTML(s, i, draft.steps.length)).join("")}</div>
        ${addingStep
          ? `<div class="palette">${Object.entries(STEP_LIBRARY).map(([type, lib]) => `<button data-add="${type}"><span>${lib.icon}</span><span>${lib.label}</span></button>`).join("")}<button class="ghost" data-add-cancel>Cancel</button></div>`
          : `<button class="add-step" data-add-open>+ Add step</button>`}
      </div>

      ${editingId ? `<div class="section"><div class="section-t">Recent runs</div><div id="runs"><div class="muted">loading…</div></div></div>` : ""}
    </div>`;
}

async function loadRuns() {
  try {
    const { runs } = await apiFetch(`/workflows/${editingId}/runs`);
    const el = $("#runs");
    if (!el) return;
    if (!runs.length) { el.innerHTML = `<div class="muted">No runs yet.</div>`; return; }
    el.innerHTML = runs.map((r) => `<div class="run">
      <div class="rhead"><span class="pill p-${r.status}">${r.status}</span><span class="muted" style="text-transform:uppercase;font-size:10.5px">${r.trigger_type}</span><span class="rwhen">${timeAgo(r.started_at)}</span></div>
      ${r.error ? `<div style="color:#fca5a5;font-size:12px;margin-top:6px">${esc(r.error)}</div>` : ""}
      ${(r.log || []).map((l) => `<div class="logline ${l.status === "error" ? "err" : l.status === "stopped" ? "stopped" : ""}"><span class="dot"></span><span style="font-weight:600">${esc(l.step)}</span><span class="msg" title="${esc(l.message)}">${esc(l.message)}</span><span class="ms">${l.ms}ms</span></div>`).join("")}
    </div>`).join("");
  } catch { /* ignore */ }
}

// editor event delegation
$("#editor-root").addEventListener("click", async (e) => {
  if (e.target.closest("[data-close]")) return closeEditor();
  const trig = e.target.closest("[data-trigger]");
  if (trig) { draft.trigger = { ...draft.trigger, type: trig.dataset.trigger }; renderEditor(); return; }
  if (e.target.closest("[data-add-open]")) { addingStep = true; renderEditor(); return; }
  if (e.target.closest("[data-add-cancel]")) { addingStep = false; renderEditor(); return; }
  const add = e.target.closest("[data-add]");
  if (add) { draft.steps.push(newStep(add.dataset.add)); addingStep = false; renderEditor(); return; }
  const rm = e.target.closest("[data-remove]");
  if (rm) { draft.steps.splice(+rm.dataset.step, 1); renderEditor(); return; }
  const mv = e.target.closest("[data-move]");
  if (mv) {
    const i = +mv.dataset.step, j = i + +mv.dataset.move;
    if (j >= 0 && j < draft.steps.length) { [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]]; renderEditor(); }
    return;
  }
  if (e.target.closest("[data-save]")) return saveDraft();
  if (e.target.closest("[data-runnow]")) return runDraft();
});

// keep draft synced with inputs without re-rendering (preserves focus)
$("#editor-root").addEventListener("input", (e) => {
  const el = e.target;
  const field = el.dataset.field;
  if (field) {
    if (field === "cron") draft.trigger.cron = el.value;
    else if (field === "enabled") draft.enabled = el.checked;
    else draft[field] = el.value;
    return;
  }
  if (el.dataset.name !== undefined && el.dataset.step !== undefined) { draft.steps[+el.dataset.step].name = el.value; return; }
  if (el.dataset.cfg !== undefined && el.dataset.step !== undefined) {
    const step = draft.steps[+el.dataset.step];
    step.config[el.dataset.cfg] = el.type === "checkbox" ? el.checked : el.value;
  }
});

function parseJsonFields(wf) {
  // JSON-typed configs are edited as text — parse before sending.
  for (const step of wf.steps) {
    for (const f of STEP_LIBRARY[step.type].fields) {
      const v = step.config[f.key];
      if (f.kind === "json" && typeof v === "string" && v.trim()) {
        try { step.config[f.key] = JSON.parse(v); } catch { throw new Error(`${step.name}: “${f.label}” is not valid JSON`); }
      }
      if (f.kind === "number" && v != null && v !== "") step.config[f.key] = Number(v);
    }
  }
}

async function saveDraft() {
  if (!draft.name.trim()) return toast("Name is required", "err");
  try {
    const body = JSON.parse(JSON.stringify(draft));
    parseJsonFields(body); // parse the clone we send, leaving the editable draft as text
    const saved = editingId
      ? await apiFetch(`/workflows/${editingId}`, { method: "PUT", body: JSON.stringify(body) })
      : await apiFetch("/workflows", { method: "POST", body: JSON.stringify(body) });
    toast(editingId ? "Saved ✓" : "Created ✓", "ok");
    editingId = saved.workflow.id;
    draft = JSON.parse(JSON.stringify(saved.workflow));
    renderEditor();
    loadRuns();
    loadList();
  } catch (e) {
    toast(e.message, "err");
  }
}

async function runDraft() {
  if (!editingId) return toast("Save first, then run.", "warn");
  try {
    const r = await apiFetch(`/workflows/${editingId}/run`, { method: "POST", body: "{}" });
    toast(r.ok ? "Ran ✓" : `Ran with error: ${r.error}`, r.status === "error" ? "err" : "ok");
    loadRuns();
    loadList();
  } catch (e) { toast(e.message, "err"); }
}

loadList();
