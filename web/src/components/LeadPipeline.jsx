import { useCallback, useEffect, useState } from "react";
import { api, streamInboxScan } from "../lib/api.js";
import "./LeadPipeline.css";

function timeAgo(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

const STATUS_TONE = {
  new: "lp-st-new",
  qualified: "lp-st-qual",
  contacted: "lp-st-contact",
  won: "lp-st-won",
  lost: "lp-st-lost",
};

function initials(name = "", email = "") {
  const base = (name || email || "?").trim();
  const parts = base.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

export default function LeadPipeline({ showToast, onChanged }) {
  const [inbox, setInbox] = useState(null); // { connected, emails } | null
  const [leads, setLeads] = useState(null); // [] | null
  const [err, setErr] = useState("");
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(null); // { index, total } | null

  const load = useCallback(() => {
    setErr("");
    api("/inbox")
      .then(setInbox)
      .catch((e) => setErr(String(e.message || e)));
    api("/leads")
      .then((d) => setLeads(d.leads || []))
      .catch((e) => setErr(String(e.message || e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const scan = useCallback(async () => {
    setScanning(true);
    setProgress(null);
    try {
      const out = await streamInboxScan(
        { maxResults: 20 },
        {
          onEvent: (evt) => {
            if (evt.type === "start") {
              setProgress({ index: 0, total: evt.total });
              return;
            }
            if (evt.index) setProgress({ index: evt.index, total: evt.total });

            if (evt.type === "lead-added") {
              // Drop it into the pipeline the moment it's qualified — no need to
              // wait for the rest of the inbox to finish scanning.
              setLeads((prev) => [evt.lead, ...(prev || [])]);
              setInbox((prev) =>
                prev ? { ...prev, emails: prev.emails.map((m) => (m.email === evt.email ? { ...m, alreadyLead: true } : m)) } : prev
              );
              onChanged?.();
            }
          },
        }
      );
      showToast?.(out?.summary || `Added ${out?.added?.length || 0} lead(s).`, out?.added?.length ? "ok" : "warn");
    } catch (e) {
      showToast?.(`Scan failed: ${String(e.message || e)}`, "err");
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }, [onChanged, showToast]);

  const connected = inbox?.connected;
  const emails = inbox?.emails || [];

  return (
    <div className="lp">
      <div className="lp-head">
        <div>
          <h2 className="lp-title">Lead Pipeline</h2>
          <div className="lp-sub">
            {leads == null ? "—" : `${leads.length} lead${leads.length === 1 ? "" : "s"}`} ·{" "}
            {connected == null ? "inbox…" : connected ? `${emails.length} recent email${emails.length === 1 ? "" : "s"}` : "inbox not connected"}
          </div>
        </div>
        <button className="lp-scan" onClick={scan} disabled={scanning || connected === false}>
          {scanning ? (progress?.total ? `Scanning ${progress.index}/${progress.total}…` : "Scanning…") : "⚡ Scan inbox → leads"}
        </button>
      </div>

      {err && <div className="lp-error">{err}</div>}

      <div className="lp-cols">
        {/* ---------------- Inbox ---------------- */}
        <section className="lp-panel">
          <div className="lp-panel-title">📥 Inbox</div>

          {inbox == null ? (
            <div className="lp-skel" />
          ) : connected === false ? (
            <div className="lp-empty">
              Google isn't connected.
              <div className="lp-hint">Connect Google from the Approvals tab side panel, then reload.</div>
            </div>
          ) : emails.length === 0 ? (
            <div className="lp-empty">Inbox is empty right now.</div>
          ) : (
            <div className="lp-list">
              {emails.map((m) => (
                <div className={`lp-mail ${m.unread ? "is-unread" : ""}`} key={m.id}>
                  <div className="lp-avatar">{initials(m.name, m.email)}</div>
                  <div className="lp-mail-body">
                    <div className="lp-mail-top">
                      <span className="lp-mail-from" title={m.email}>{m.name || m.email || "(unknown)"}</span>
                      <span className="lp-mail-when">{timeAgo(m.date)}</span>
                    </div>
                    <div className="lp-mail-subj">{m.subject || "(no subject)"}</div>
                    {m.snippet && <div className="lp-mail-snip">{m.snippet}</div>}
                    <div className="lp-badges">
                      {m.unread && <span className="lp-badge lp-b-unread">unread</span>}
                      {m.alreadyLead && <span className="lp-badge lp-b-lead">✓ lead</span>}
                      {m.automated && <span className="lp-badge lp-b-auto">automated</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ---------------- Leads ---------------- */}
        <section className="lp-panel">
          <div className="lp-panel-title">🎯 Leads</div>

          {leads == null ? (
            <div className="lp-skel" />
          ) : leads.length === 0 ? (
            <div className="lp-empty">
              No leads yet.
              <div className="lp-hint">Hit “Scan inbox → leads” — AYUS will read your mail and add the genuine prospects.</div>
            </div>
          ) : (
            <div className="lp-list">
              {leads.map((l) => (
                <div className="lp-lead" key={l.id}>
                  <div className="lp-avatar">{initials(l.name, l.email)}</div>
                  <div className="lp-lead-body">
                    <div className="lp-mail-top">
                      <span className="lp-mail-from" title={l.email}>{l.name || l.email}</span>
                      {typeof l.score === "number" && <span className="lp-score">{l.score}/10</span>}
                    </div>
                    <div className="lp-lead-meta">
                      <span className={`lp-badge ${STATUS_TONE[l.status] || "lp-st-new"}`}>{l.status || "new"}</span>
                      {l.source && <span className="lp-source">{l.source}</span>}
                      <span className="lp-mail-when">{timeAgo(l.created_at)}</span>
                    </div>
                    {l.ai_notes && <div className="lp-mail-snip">{l.ai_notes}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
