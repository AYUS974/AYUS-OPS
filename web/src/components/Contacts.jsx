import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import "./Contacts.css";

function initials(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

const EMPTY = { id: null, name: "", phone: "", note: "" };

export default function Contacts({ showToast }) {
  const [contacts, setContacts] = useState(null); // [] | null while loading
  const [wa, setWa] = useState(null); // WhatsApp bot status
  const [form, setForm] = useState(EMPTY);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [sendTo, setSendTo] = useState(null); // contact being messaged
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(() => {
    api("/contacts")
      .then((d) => setContacts(d.contacts || []))
      .catch((e) => setErr(String(e.message || e)));
    api("/whatsapp/status")
      .then(setWa)
      .catch(() => setWa(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      await api("/contacts", { method: "POST", body: JSON.stringify(form) });
      showToast?.(form.id ? "Contact updated." : `${form.name} saved.`, "ok");
      setForm(EMPTY);
      load();
    } catch (e2) {
      setErr(String(e2.message || e2));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!confirm(`Delete ${c.name}?`)) return;
    try {
      await api(`/contacts/${c.id}`, { method: "DELETE" });
      if (form.id === c.id) setForm(EMPTY);
      load();
    } catch (e) {
      showToast?.(String(e.message || e), "err");
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      await api("/whatsapp/send", { method: "POST", body: JSON.stringify({ to: sendTo.phone, message: text }) });
      showToast?.(`Sent to ${sendTo.name}.`, "ok");
      setSendTo(null);
      setDraft("");
    } catch (e) {
      showToast?.(`Send failed: ${String(e.message || e)}`, "err");
    } finally {
      setSending(false);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (contacts || []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));

  return (
    <div className="ct">
      <div className="ct-head">
        <div>
          <h2 className="ct-title">Contacts</h2>
          <div className="ct-sub">
            {contacts == null ? "—" : `${contacts.length} saved`} ·{" "}
            {wa?.connected ? "WhatsApp connected" : wa?.enabled ? "WhatsApp: scan the QR in the server terminal" : "WhatsApp bot off"}
          </div>
        </div>
        <input className="ct-search" placeholder="Search name or number…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {err && <div className="ct-error">{err}</div>}

      <div className="ct-cols">
        {/* ---------------- Add / edit ---------------- */}
        <form className="ct-panel ct-form" onSubmit={save}>
          <div className="ct-panel-title">{form.id ? "✎ Edit contact" : "＋ New contact"}</div>

          <label className="ct-label">Name</label>
          <input className="ct-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Rahul Sharma" required />

          <label className="ct-label">WhatsApp number</label>
          <input
            className="ct-input"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="9876543210"
            required
          />
          <div className="ct-hint">10 digits = India (+91) automatically. For any other country type the full number with its code.</div>

          <label className="ct-label">Note <span className="ct-opt">(optional)</span></label>
          <input className="ct-input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Client — Beram project" />

          <div className="ct-actions">
            <button className="ct-btn" type="submit" disabled={saving}>{saving ? "Saving…" : form.id ? "Save changes" : "Add contact"}</button>
            {form.id && <button className="ct-btn ct-btn-ghost" type="button" onClick={() => setForm(EMPTY)}>Cancel</button>}
          </div>

          <div className="ct-tip">
            Saved contacts are how AYUS sends by name — just say <em>“Rahul ko message bhej do…”</em>.
          </div>
        </form>

        {/* ---------------- List ---------------- */}
        <section className="ct-panel">
          <div className="ct-panel-title">📇 Contact book</div>

          {contacts == null ? (
            <div className="ct-skel" />
          ) : shown.length === 0 ? (
            <div className="ct-empty">
              {contacts.length ? "No contact matches that search." : "No contacts yet."}
              <div className="ct-hint">Add one on the left, then tell AYUS to message them by name.</div>
            </div>
          ) : (
            <div className="ct-list">
              {shown.map((c) => (
                <div className="ct-row" key={c.id}>
                  <div className="ct-avatar">{initials(c.name)}</div>
                  <div className="ct-body">
                    <div className="ct-name">{c.name}</div>
                    <div className="ct-phone mono">+{c.phone}</div>
                    {c.note && <div className="ct-note">{c.note}</div>}
                  </div>
                  <div className="ct-row-actions">
                    <button className="ct-icon" title="Send a WhatsApp message" onClick={() => { setSendTo(c); setDraft(""); }} disabled={!wa?.connected}>✉</button>
                    <button className="ct-icon" title="Edit" onClick={() => setForm({ id: c.id, name: c.name, phone: c.phone, note: c.note || "" })}>✎</button>
                    <button className="ct-icon ct-icon-danger" title="Delete" onClick={() => remove(c)}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {sendTo && (
        <div className="ct-modal-back" onClick={() => setSendTo(null)}>
          <div className="ct-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ct-modal-title">WhatsApp → {sendTo.name}</div>
            <div className="ct-phone mono">+{sendTo.phone}</div>
            <textarea className="ct-input ct-area" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type your message…" />
            <div className="ct-actions">
              <button className="ct-btn" onClick={send} disabled={sending || !draft.trim()}>{sending ? "Sending…" : "Send"}</button>
              <button className="ct-btn ct-btn-ghost" onClick={() => setSendTo(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
