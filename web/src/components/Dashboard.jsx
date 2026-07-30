import { useCallback, useEffect, useRef, useState } from "react";
import { api, getSupabase } from "../lib/api.js";
import { speak, stopSpeaking, onSpeaking } from "../lib/voice.js";
import { useAyusVoice } from "../lib/useAyusVoice.js";
import AyusReactor from "./AyusReactor.jsx";
import MissionControl from "./MissionControl.jsx";
import LeadPipeline from "./LeadPipeline.jsx";
import Contacts from "./Contacts.jsx";
import Notes from "./Notes.jsx";
import Workflows from "./Workflows.jsx";
import KnowledgeVault from "./KnowledgeVault.jsx";
import Docs from "./Docs.jsx";

const AGENTS = ["sales", "finance", "marketing", "secretary", "hr", "cto"];

// Tracks the <=900px breakpoint so the sidebar can behave as an overlay drawer
// there (closed by default, dismissible) versus a persistent rail on desktop.
function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

const AGENT_NAMES = {
  sales: "Arjun",
  finance: "Meera",
  marketing: "Kabir",
  secretary: "AYUS",
  hr: "Isha",
  cto: "Vikram",
};

const AGENT_META = {
  sales:     { display: "Researcher",    subtitle: "RESEARCH OPS",       icon: "A", desc: "Performs market research, competitor analysis, and gathers deep domain insights." },
  finance:   { display: "Finance",       subtitle: "TREASURY SYSTEM",    icon: "M", desc: "Manages invoices, sends payment reminders, and tracks collections." },
  marketing: { display: "Content Writer", subtitle: "SCRIPTWRITING",      icon: "K", desc: "Writes video/reel scripts, drafts blog posts, and writes compelling copy." },
  secretary: { display: "AYUS",          subtitle: "EXECUTIVE ASSISTANT", icon: "◈", desc: "Your JARVIS-style operations intelligence — coordinates, drafts, and runs daily ops." },
  hr:        { display: "Social Media & Ads", subtitle: "CAMPAIGNS",     icon: "I", desc: "Creates AI-generated advertisement posts, videos, reels, and runs marketing campaigns." },
  cto:       { display: "Builder",       subtitle: "BUILD SYSTEM",       icon: "V", desc: "Builds dashboards, codebases, integrations, web apps, and executes developer tasks." },
};

const NAV_ITEMS = [
  { id: "ayus",      icon: "◈", label: "AYUS" },
  { id: "missions",  icon: "🛰", label: "Missions" },
  { id: "workflows", icon: "⚡", label: "Workflows" },
  { id: "agents",    icon: "◎", label: "Agents" },
  { id: "approvals", icon: "✓", label: "Approvals" },
  { id: "insights",  icon: "◴", label: "Insights" },
  { id: "leads",     icon: "◇", label: "Lead Pipeline" },
  { id: "contacts",  icon: "☏", label: "Contacts" },
  { id: "notes",     icon: "✎", label: "Notes" },
  { id: "content",   icon: "✎", label: "Content" },
  { id: "vault",     icon: "◫", label: "Knowledge Vault" },
  { id: "docs",      icon: "▤", label: "Documentation" },
];

// The TTS voice key for an agent ("secretary" speaks with the AYUS voice)
const voiceIdFor = (agent) => (agent === "secretary" ? "ayus" : agent);

function timeAgo(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function money(amount, currency = "INR") {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

// agent_runs stores raw error strings (often a JSON blob from an API).
// Pull out the human message so the log stays readable.
function prettySummary(s) {
  if (!s) return "";
  const m = s.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : s;
}

function useCountUp(target, duration = 750) {
  const [val, setVal] = useState(typeof target === "number" ? 0 : target);
  useEffect(() => {
    if (typeof target !== "number" || !Number.isFinite(target)) {
      setVal(target);
      return;
    }
    let start, raf;
    const step = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function StatTile({ label, value, sub, tone }) {
  const display = useCountUp(value);
  return (
    <div className={`stat ${tone ? "stat-" + tone : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{display}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function VoiceViz() {
  return (
    <span className="voice-viz" aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}

function EmailPreview({ payload }) {
  return (
    <div className="email-preview">
      <div className="email-field"><span>To</span>{payload.to || "—"}</div>
      <div className="email-field"><span>Subject</span>{payload.subject || "—"}</div>
      <div className="email-body">{payload.body || ""}</div>
    </div>
  );
}

function ReviewPreview({ review }) {
  return (
    <div className="review-preview">
      <p className="review-verdict">{review.verdict}</p>
      {review.hooks?.length > 0 && (
        <>
          <div className="review-heading">Stronger hooks</div>
          <ol>{review.hooks.map((h, i) => <li key={i}>{h}</li>)}</ol>
        </>
      )}
      {review.improvements?.length > 0 && (
        <>
          <div className="review-heading">Improvements</div>
          <ul>{review.improvements.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </>
      )}
    </div>
  );
}

function ScreeningPreview({ review }) {
  return (
    <div className="review-preview">
      <p className="review-verdict">{review.summary}</p>
      {review.strengths?.length > 0 && (
        <>
          <div className="review-heading">Strengths</div>
          <ul>{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      )}
      {review.concerns?.length > 0 && (
        <>
          <div className="review-heading">Concerns</div>
          <ul>{review.concerns.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </>
      )}
      {review.interview_questions?.length > 0 && (
        <>
          <div className="review-heading">Interview questions</div>
          <ol>{review.interview_questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
        </>
      )}
    </div>
  );
}

function TechReviewPreview({ review }) {
  return (
    <div className="review-preview">
      <p className="review-verdict">
        <strong>{review.priority}</strong> — {review.summary}
      </p>
      {review.recommendation && (
        <>
          <div className="review-heading">Recommendation</div>
          <p className="review-verdict">{review.recommendation}</p>
        </>
      )}
      {review.next_steps?.length > 0 && (
        <>
          <div className="review-heading">Next steps</div>
          <ol>{review.next_steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </>
      )}
    </div>
  );
}

function ManualTaskPreview({ payload }) {
  const tasks = payload.tasks || [];
  return (
    <div className="manual-task-preview">
      {tasks.length > 0 ? (
        <ul className="task-list-details">
          {tasks.map((t, i) => (
            <li key={i} className="task-item-detail">
              <span className="task-bullet">✦</span>
              <div className="task-info">
                <strong>{t.task_title}</strong>
                <p>{t.task_description}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No detailed tasks specified.</p>
      )}
    </div>
  );
}

function ActionCard({ action, onDecide }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const isEmail =
    action.type === "send_followup" || action.type === "send_reminder" || action.type === "gmail_send";
  const isManual = action.type === "manual_task";

  async function decide(decision) {
    setBusy(true);
    try {
      let reason = "";
      if (decision === "rejected") {
        reason = window.prompt("Why reject? (optional — the agent learns from this)") || "";
      }
      await onDecide(action.id, decision, reason);
    } finally {
      setBusy(false);
    }
  }

  async function readAloud() {
    if (reading) {
      stopSpeaking();
      setReading(false);
      return;
    }
    const name = AGENT_NAMES[action.agent] || action.agent;
    const body = isEmail
      ? `Email draft: ${action.payload?.subject || ""}. ${action.payload?.body || ""}`
      : action.summary || "";
    setReading(true);
    await speak(`${name} here. ${action.title}. ${body}`, voiceIdFor(action.agent));
    setReading(false);
  }

  return (
    <div className={`card ${action.urgent ? "card-urgent" : ""}`}>
      <div className="card-top">
        <span className={`agent-tag agent-${action.agent}`}>{action.agent}</span>
        <span className="type-tag">{action.type.replace(/_/g, " ")}</span>
        {action.urgent && <span className="urgent-pill" title="Marked urgent">URGENT</span>}
        {action.meta?.via === "handoff" && (
          <span className="handoff-pill" title={`Handed off from ${AGENT_NAMES[action.meta.from] || action.meta.from}`}>
            ↪ {AGENT_NAMES[action.meta.from] || action.meta.from}
          </span>
        )}
        <button
          className={`card-speak-btn ${reading ? "reading" : ""}`}
          title={reading ? "Stop" : `${AGENT_NAMES[action.agent] || action.agent} se suno`}
          onClick={readAloud}
        >
          {reading ? "■" : "🔊"}
        </button>
        <span className="card-time">{timeAgo(action.created_at)}</span>
      </div>
      <h3>{action.title}</h3>
      {action.summary && <div className="summary">{action.summary}</div>}

      <button className="expand-btn" onClick={() => setOpen(!open)}>
        {open ? "▾ hide" : "▸ view"} {isEmail ? "email draft" : isManual ? "agenda items" : "full review"}
      </button>
      {open && (
        <div className="card-detail">
          {isEmail ? (
            <EmailPreview payload={action.payload || {}} />
          ) : isManual ? (
            <ManualTaskPreview payload={action.payload || {}} />
          ) : action.type === "candidate_review" && action.payload?.review ? (
            <ScreeningPreview review={action.payload.review} />
          ) : action.type === "tech_review" && action.payload?.review ? (
            <TechReviewPreview review={action.payload.review} />
          ) : action.payload?.review ? (
            <ReviewPreview review={action.payload.review} />
          ) : (
            <pre className="payload">{JSON.stringify(action.payload, null, 2)}</pre>
          )}
        </div>
      )}

      <div className="card-actions">
        <button className="btn btn-approve" disabled={busy} onClick={() => decide("approved")}>
          {busy ? "Working…" : isManual ? "✓ Mark Complete" : "✓ Approve & execute"}
        </button>
        <button className="btn btn-reject" disabled={busy} onClick={() => decide("rejected")}>
          {isManual ? "Dismiss" : "Reject"}
        </button>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <>
      <div className="skeleton" style={{ height: 90 }} />
      <div className="skeleton" style={{ height: 140 }} />
      <div className="skeleton" style={{ height: 140 }} />
    </>
  );
}

/* ================================================================
   SIDEBAR
   ================================================================ */
function Sidebar({ session, activeNav, onNavChange, agents, filter, onSelectAgent, busy, lastRunFor, countBy, speakingAgent }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="wordmark">
          <h1>AYUS&nbsp;OPS</h1>
          <span>portal</span>
        </div>
        <div className="sidebar-subtitle">Agentic Growth Operations</div>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-nav-label">Command Center</div>
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={`nav-item ${activeNav === item.id ? "active" : ""}`}
            onClick={() => onNavChange(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-agents">
        <div className="sidebar-agents-label">Agents</div>
        {AGENTS.map(id => {
          const meta = AGENT_META[id];
          const run = lastRunFor(id);
          const status = busy ? "working" : run?.status === "error" ? "error" : "idle";
          const statusLabel = busy ? "working" : run?.status === "error" ? "error" : "idle";
          const pending = countBy(id);
          const isSpeaking = speakingAgent && (speakingAgent === id || (speakingAgent === "ayus" && id === "secretary"));

          return (
            <button
              key={id}
              className={`sidebar-agent-card a-${id} ${filter === id ? "active" : ""} ${isSpeaking ? "speaking" : ""}`}
              onClick={() => onSelectAgent(id)}
              title={`${AGENT_NAMES[id]} — ${meta.display}`}
            >
              <div className="sidebar-agent-avatar" style={{ color: `var(--${id === "secretary" ? "secretary" : id})` }}>
                {meta.icon}
              </div>
              <div className="sidebar-agent-info">
                <div className="sidebar-agent-name">{AGENT_NAMES[id]}</div>
                <div className="sidebar-agent-role">{meta.subtitle}</div>
              </div>
              <div className="sidebar-agent-status">
                <span className={`status-dot ${status}`} />
                {pending > 0 && <span style={{ color: "var(--reject)", fontWeight: 700 }}>{pending}</span>}
              </div>
            </button>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button
          className="sidebar-signout"
          title={session.user?.email}
          onClick={() => getSupabase().auth.signOut()}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

/* ================================================================
   TOPBAR
   ================================================================ */
function TopBar({ busy, running, runNow, navCollapsed, onToggleNav }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="topbar">
      <button
        className="nav-toggle-btn"
        onClick={onToggleNav}
        title="Toggle navigation"
        aria-label="Toggle navigation"
      >
        ☰
      </button>

      <div className={`topbar-status ${busy ? "is-running" : ""}`}>
        <span className="top-dot" />
        {busy ? "Agents Running" : "Agentic System Operational"}
      </div>

      <span className="topbar-clock">
        {now.toLocaleTimeString("en-IN", { hour12: false })}
      </span>

      <div className="topbar-actions">
        <button className="run-btn" disabled={running} onClick={runNow}>
          {running ? <span className="spinner" /> : "▶"} {running ? "Running…" : "Run agents"}
        </button>
      </div>
    </div>
  );
}

/* ================================================================
   AGENT NETWORK — hierarchy view (replaces CouncilChamber)
   ================================================================ */
function AgentNetwork({ actions, busy, filter, onSelectAgent, lastRunFor, countBy, speakingAgent }) {
  const llmModel = process.env.GEMINI_MODEL || process.env.ANTHROPIC_MODEL || "gemini-2.5-flash";

  return (
    <div className="agent-network">
      <div className="network-header">
        <div className="network-title">Agent Network</div>
        <div className="network-subtitle">
          One command brain coordinating {AGENTS.length} specialist agent roles.
        </div>
      </div>

      {/* CEO / Orchestrator card */}
      <div className="ceo-card-wrapper">
        <div
          className="ceo-card"
          onClick={() => onSelectAgent("ceo")}
          title="You — CEO / Orchestrator"
        >
          <div className="ceo-avatar">★</div>
          <div className="ceo-info">
            <div className="ceo-status-row">
              <span className={`ceo-status-badge ${busy ? "status-working" : "status-idle"}`}>
                <span className="mini-dot" />
                {busy ? "working" : "operational"}
              </span>
            </div>
            <div className="ceo-name">CEO/Orchestrator</div>
            <div className="ceo-role">Command Layer</div>
            <div className="ceo-desc">Routes work, reviews context, coordinates specialists, and returns the operator debrief.</div>
          </div>
          <div className="ceo-stats">
            <div className="ceo-stat-tile">
              <div className="ceo-stat-label">Pending</div>
              <div className="ceo-stat-val">{actions.length}</div>
            </div>
            <div className="ceo-stat-tile">
              <div className="ceo-stat-label">Agents</div>
              <div className="ceo-stat-val">{AGENTS.length}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tree connectors: trunk → rail → one drop per agent. Geometry is
          derived from the agent count + grid gap so it stays aligned if AGENTS
          changes; the CSS hides connectors below 1280px (grid then goes 3-wide).
          Column center i = i·((100%−gaps)/n + gap) + (100%−gaps)/(2n). */}
      {(() => {
        const n = AGENTS.length;
        const gap = 14; // must match .agent-cards-row gap in index.css
        const gaps = (n - 1) * gap;
        const edge = `(100% - ${gaps}px) / ${2 * n}`;
        return (
          <div className="tree-connectors" aria-hidden="true">
            <span className="tree-trunk" />
            <span className="tree-rail" style={{ left: `calc(${edge})`, right: `calc(${edge})` }} />
            {AGENTS.map((id, i) => (
              <span
                key={id}
                className="tree-drop"
                style={{ left: `calc(${2 * i + 1} * ${edge} + ${i * gap}px)` }}
              />
            ))}
          </div>
        );
      })()}

      {/* Agent cards row */}
      <div className="agent-cards-row">
        {AGENTS.map(id => {
          const meta = AGENT_META[id];
          const run = lastRunFor(id);
          const pending = countBy(id);
          const status = busy ? "working" : run?.status === "error" ? "error" : "idle";
          const statusLabel = busy ? "working" : run?.status === "error" ? "error" : "idle";
          const isSelected = filter === id;
          const isSpeaking = speakingAgent && (speakingAgent === id || (speakingAgent === "ayus" && id === "secretary"));

          return (
            <div
              key={id}
              className={`agent-card a-${id} ${isSelected ? "active" : ""} ${isSpeaking ? "speaking" : ""}`}
              onClick={() => onSelectAgent(id)}
              title={`${AGENT_NAMES[id]} — ${meta.display}`}
            >
              <div className="agent-card-top">
                <div className="agent-card-avatar">{meta.icon}</div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span className={`agent-card-badge status-${status}`}>
                    <span className="mini-dot" />
                    {statusLabel}
                  </span>
                  {pending > 0 && <span className="agent-card-pending">{pending}</span>}
                </div>
              </div>
              <div className="agent-card-name">{meta.display}</div>
              <div className="agent-card-subtitle">{meta.subtitle}</div>
              <div className="agent-card-desc">{meta.desc}</div>
              <div className="agent-card-model">
                MODEL <b>{llmModel}</b>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatMarkdown(text) {
  if (!text) return [];
  const lines = text.split("\n");
  
  return lines.map((line, idx) => {
    const trimmed = line.trim();
    
    // Bold replacement
    let content = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    // Inline code replacement
    content = content.replace(/`(.*?)`/g, "<code>$1</code>");

    // Horizontal rule
    if (trimmed === "---" || trimmed === "***") {
      return <hr key={idx} className="chat-hr" />;
    }

    // Headers
    if (trimmed.startsWith("### ")) {
      const headerText = content.trim().substring(4);
      return <h3 key={idx} className="chat-h3" dangerouslySetInnerHTML={{ __html: headerText }} />;
    }
    if (trimmed.startsWith("## ")) {
      const headerText = content.trim().substring(3);
      return <h2 key={idx} className="chat-h2" dangerouslySetInnerHTML={{ __html: headerText }} />;
    }
    if (trimmed.startsWith("# ")) {
      const headerText = content.trim().substring(2);
      return <h1 key={idx} className="chat-h1" dangerouslySetInnerHTML={{ __html: headerText }} />;
    }

    // Bullet list item
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const itemText = content.trim().substring(2);
      return (
        <li key={idx} className="chat-bullet-li" dangerouslySetInnerHTML={{ __html: itemText }} />
      );
    }

    // Ordered list item
    const matchOrdered = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (matchOrdered) {
      const dotIndex = content.indexOf(".");
      const itemText = content.substring(dotIndex + 1).trim();
      return (
        <li key={idx} className="chat-ordered-li" dangerouslySetInnerHTML={{ __html: itemText }} />
      );
    }

    // Paragraph spacer for empty lines
    if (trimmed === "") {
      return <div key={idx} className="chat-paragraph-spacer" />;
    }

    return (
      <p key={idx} className="chat-p" dangerouslySetInnerHTML={{ __html: content }} />
    );
  });
}

function AyusChatDrawer({ isOpen, onClose, onActionProposed, showToast }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef(null);

  // All voice behaviour (dictation, hands-free conversation, "Hello AYUS" wake
  // word, spoken replies) lives in one hook — see lib/useAyusVoice.js.
  const voice = useAyusVoice({
    open: isOpen,
    busy: loading,
    onUtterance: (text) => sendMessage(text),
    showToast,
  });
  const { support, voiceOn, wakeOn, listening, speaking } = voice;

  // Load chat history from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("ayus_chat_history");
    if (saved) {
      try {
        setMessages(JSON.parse(saved));
      } catch (e) {
        initWelcomeMessage();
      }
    } else {
      initWelcomeMessage();
    }
  }, [isOpen]);

  function initWelcomeMessage() {
    const welcome = [
      {
        role: "assistant",
        content: "AYUS online. I've reviewed the current ops status. I can draft emails, schedule tasks, or summarise what Arjun (Research), Meera (Finance), and Kabir (Content) are working on. How may I help, sir?",
        timestamp: new Date().toISOString()
      }
    ];
    setMessages(welcome);
    localStorage.setItem("ayus_chat_history", JSON.stringify(welcome));
  }

  // Auto-scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendMessage(text) {
    if (!text.trim() || loading) return;
    voice.beginRequest(); // pause the wake word while AYUS thinks/speaks

    const userMsg = {
      role: "user",
      content: text,
      timestamp: new Date().toISOString()
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");
    setLoading(true);

    try {
      const chatPayload = updatedMessages.map(m => ({
        role: m.role,
        content: m.content
      }));

      const response = await api("/secretary/chat", {
        method: "POST",
        body: JSON.stringify({ messages: chatPayload })
      });

      const ayusMsg = {
        role: "assistant",
        content: response.message,
        toolEvents: response.toolEvents || [],
        timestamp: new Date().toISOString(),
        suggestedAction: response.hasSuggestion ? response.suggestedAction : null,
      };

      const finalMessages = [...updatedMessages, ayusMsg];
      setMessages(finalMessages);
      localStorage.setItem("ayus_chat_history", JSON.stringify(finalMessages));
      // The proposal is already in the queue — refresh the approvals badge.
      if (response.hasSuggestion) onActionProposed?.();
      voice.speakReply(response.message); // speaks if un-muted; keeps a conversation going
    } catch (err) {
      showToast("Error communicating with AYUS: " + err.message, "err");
      const errorMsg = {
        role: "assistant",
        content: "Sorry, kuch issue aa gaya server se baat karne mein. Phir se try kariye.",
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, errorMsg]);
      voice.speakReply(errorMsg.content); // keep hands-free conversation alive on errors
    } finally {
      setLoading(false);
    }
  }

  function handleSend(e) {
    e.preventDefault();
    sendMessage(input);
  }

  function clearHistory() {
    if (window.confirm("Are you sure you want to clear chat history with AYUS?")) {
      initWelcomeMessage();
    }
  }

  if (!isOpen) return null;

  return (
    <div className="ayus-drawer-container">
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer-panel">
        <div className="drawer-header">
          <div className="drawer-agent-info">
            <div className="ayus-avatar-small"><span>◈</span></div>
            <div>
              <h3>AYUS {speaking && <VoiceViz />}</h3>
              <span className="drawer-status">
                <span className={`dot pulse ${speaking ? "dot-speaking" : ""}`} />
                {loading ? "thinking…" : speaking ? "speaking…" : listening ? "listening…" : "standing by"}
              </span>
            </div>
          </div>
          <div className="drawer-header-actions">
            <button
              className={`voice-toggle-btn ${voiceOn ? "on" : ""}`}
              title={voiceOn ? "Voice replies ON — click to mute" : "Voice replies OFF — click to unmute"}
              onClick={voice.toggleVoice}
            >
              {voiceOn ? "🔊" : "🔇"}
            </button>
            <button className="clear-chat-btn" title="Clear chat history" onClick={clearHistory}>🗑</button>
            <button className="close-drawer-btn" onClick={onClose}>&times;</button>
          </div>
        </div>

        <div className="drawer-messages">
          {messages.map((m, idx) => (
            <div key={idx} className={`chat-message-row ${m.role === "user" ? "user-row" : "ayus-row"}`}>
              <div className="chat-bubble">
                <div className="chat-content">
                  {m.role === "user" ? m.content : formatMarkdown(m.content)}
                </div>
                {m.toolEvents?.length > 0 && (
                  <div className="tool-events">
                    {m.toolEvents.map((t, ti) => (
                      <span key={ti} className="tool-chip" title={t}>⚙ {t.split("→")[0].trim()}</span>
                    ))}
                  </div>
                )}
                <div className="chat-time">
                  {m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ""}
                </div>
              </div>

              {m.suggestedAction && (
                <div className="chat-suggestion-card">
                  <div className="suggestion-badge">✓ QUEUED FOR APPROVAL</div>
                  <h4>{m.suggestedAction.title}</h4>
                  <p className="suggestion-summary">{m.suggestedAction.summary}</p>
                  
                  <div className="suggestion-preview-details">
                    {m.suggestedAction.type === "manual_task" ? (
                      <div className="small-task-payload">
                        {m.suggestedAction.payload?.tasks?.map((t, tIdx) => (
                          <div key={tIdx} className="small-task-item">
                            • <strong>{t.task_title}</strong>: {t.task_description}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="small-email-payload">
                        <div><strong>To:</strong> {m.suggestedAction.payload?.to}</div>
                        <div><strong>Subject:</strong> {m.suggestedAction.payload?.subject}</div>
                        <div className="small-email-body">{m.suggestedAction.payload?.body}</div>
                      </div>
                    )}
                  </div>

                  <div className="suggestion-foot">Waiting in the Approvals tab — approve it there to actually send.</div>
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="chat-message-row ayus-row">
              <div className="chat-bubble typing-bubble">
                <span className="typing-dots">
                  <i>.</i><i>.</i><i>.</i>
                </span>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <form className="drawer-input-area" onSubmit={handleSend}>
          {support.wake && (
            <button
              type="button"
              className={`mic-btn ${wakeOn ? "wake-on" : ""}`}
              title={wakeOn ? "Wake word ON — just say “Hello AYUS”" : "Wake word OFF — click to enable “Hello AYUS”"}
              onClick={voice.toggleWake}
            >
              {wakeOn ? "👂" : "💤"}
            </button>
          )}
          <button
            type="button"
            className={`mic-btn ${listening ? "listening" : ""}`}
            title={listening ? "Listening — click to stop" : "Speak to AYUS (hands-free)"}
            onClick={voice.toggleMic}
          >
            {listening ? "◉" : "🎙"}
          </button>
          <input
            type="text"
            placeholder={listening ? "Listening…" : wakeOn ? "Say “Hello AYUS” or type…" : "Type or speak to AYUS…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
          <button type="submit" className="send-msg-btn" disabled={!input.trim() || loading}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function InsBar({ label, value, max, tone }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className="ins-bar-row">
      <span className="ins-bar-label">{label}</span>
      <div className="ins-bar-track">
        <div className={`ins-bar-fill ${tone || ""}`} style={{ width: pct + "%" }} />
      </div>
      <span className="ins-bar-val">{value}</span>
    </div>
  );
}

const PIPELINE_ORDER = ["new", "qualified", "contacted", "won", "lost"];

function InsightsPanel({ active }) {
  const [a, setA] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setA(null);
    setErr("");
    api("/analytics")
      .then((d) => alive && setA(d))
      .catch((e) => alive && setErr(String(e.message || e)));
    return () => {
      alive = false;
    };
  }, [active]);

  if (!active) return null;
  if (err) return <div className="empty">Couldn't load insights.<div className="hint">{err}</div></div>;
  if (!a) return <div className="skeleton" style={{ height: 320 }} />;

  const pipeMax = Math.max(1, ...PIPELINE_ORDER.map((k) => a.pipeline[k] || 0));
  const agentMax = Math.max(1, ...a.byAgent.map((x) => x.actions));
  const seriesMax = Math.max(1, ...a.series.map((s) => s.actions));
  const healthTone = a.health >= 75 ? "good" : a.health >= 50 ? "warn" : "bad";

  return (
    <div className="insights">
      <div className="ins-grid">
        <div className="ins-card ins-health">
          <div className="ins-card-title">Company health</div>
          <div className={`health-score health-${healthTone}`}>{a.health}</div>
          <div className="health-factors">
            <InsBar label="Reliability" value={a.healthFactors.reliability} max={100} tone="good" />
            <InsBar label="Collection" value={a.healthFactors.collection} max={100} tone="good" />
            <InsBar label="Pipeline" value={a.healthFactors.pipeline} max={100} tone="good" />
            <InsBar label="Approvals" value={a.healthFactors.approval} max={100} tone="good" />
          </div>
        </div>

        <div className="ins-card">
          <div className="ins-card-title">Revenue</div>
          <div className="ins-money">
            <div className="ins-money-tile">
              <span>Collected</span>
              <b className="pos">{money(a.revenue.collected, a.revenue.currency)}</b>
            </div>
            <div className="ins-money-tile">
              <span>Outstanding</span>
              <b>{money(a.revenue.outstanding, a.revenue.currency)}</b>
            </div>
            <div className="ins-money-tile">
              <span>Overdue ({a.revenue.overdueCount})</span>
              <b className="neg">{money(a.revenue.overdue, a.revenue.currency)}</b>
            </div>
          </div>
          <div className="ins-sub">
            Approval rate: <b>{a.actions.approvalRate == null ? "—" : a.actions.approvalRate + "%"}</b> ·{" "}
            {a.actions.pending} pending now
          </div>
        </div>

        <div className="ins-card">
          <div className="ins-card-title">Lead pipeline ({a.leadsTotal})</div>
          {PIPELINE_ORDER.map((k) => (
            <InsBar key={k} label={k} value={a.pipeline[k] || 0} max={pipeMax} tone={k === "won" ? "good" : k === "lost" ? "bad" : ""} />
          ))}
        </div>

        <div className="ins-card">
          <div className="ins-card-title">Workload (30d)</div>
          {a.byAgent.map((x) => (
            <InsBar
              key={x.agent}
              label={`${AGENT_NAMES[x.agent] || x.agent}${x.errors ? " ⚠" : ""}`}
              value={x.actions}
              max={agentMax}
              tone={x.errors ? "bad" : ""}
            />
          ))}
        </div>

        <div className="ins-card ins-wide">
          <div className="ins-card-title">Activity — last 14 days</div>
          <div className="spark">
            {a.series.map((s) => (
              <div className="spark-col" key={s.day} title={`${s.day}: ${s.actions} proposed, ${s.executed} executed`}>
                <div className="spark-bar" style={{ height: Math.round((s.actions / seriesMax) * 100) + "%" }}>
                  <div className="spark-exec" style={{ height: s.actions ? Math.round((s.executed / s.actions) * 100) + "%" : "0%" }} />
                </div>
                <span className="spark-day">{s.day.slice(8)}</span>
              </div>
            ))}
          </div>
          <div className="ins-sub"><i className="legend-dot lg-prop" /> proposed <i className="legend-dot lg-exec" /> executed</div>
        </div>
      </div>
    </div>
  );
}

function GoogleConnect({ showToast }) {
  const [st, setSt] = useState(null);
  const refresh = useCallback(() => {
    api("/google/status")
      .then(setSt)
      .catch(() => setSt({ configured: false, connected: false }));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function connect() {
    try {
      const { url } = await api("/google/connect");
      window.location.href = url;
    } catch (e) {
      showToast("Google connect failed: " + e.message, "err");
    }
  }
  async function disconnect() {
    try {
      await api("/google/disconnect", { method: "POST" });
      showToast("Google disconnected", "warn");
      refresh();
    } catch (e) {
      showToast("Failed: " + e.message, "err");
    }
  }

  if (!st) return null;

  return (
    <div className={`gconnect ${st.connected ? "is-connected" : ""}`}>
      <div className="gconnect-row">
        <span className="gconnect-logo">G</span>
        <div className="gconnect-info">
          <strong>Gmail + Calendar</strong>
          <span className="gconnect-status">
            {!st.configured
              ? "Add GOOGLE_CLIENT_ID/SECRET in .env"
              : st.connected
                ? `Connected${st.account ? " · " + st.account : ""}`
                : "Not connected"}
          </span>
        </div>
      </div>
      {st.configured &&
        (st.connected ? (
          <button className="gconnect-btn ghost" onClick={disconnect}>Disconnect</button>
        ) : (
          <button className="gconnect-btn" onClick={connect}>Connect Google</button>
        ))}
    </div>
  );
}

function SpotifyConnect({ showToast }) {
  const [st, setSt] = useState(null);
  const refresh = useCallback(() => {
    api("/spotify/status")
      .then(setSt)
      .catch(() => setSt({ configured: false, connected: false }));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function connect() {
    try {
      const { url } = await api("/spotify/connect");
      window.location.href = url;
    } catch (e) {
      showToast("Spotify connect failed: " + e.message, "err");
    }
  }
  async function disconnect() {
    try {
      await api("/spotify/disconnect", { method: "POST" });
      showToast("Spotify disconnected", "warn");
      refresh();
    } catch (e) {
      showToast("Failed: " + e.message, "err");
    }
  }

  if (!st) return null;

  return (
    <div className={`gconnect ${st.connected ? "is-connected" : ""}`}>
      <div className="gconnect-row">
        <span className="gconnect-logo" style={{ background: "#1DB954" }}>♫</span>
        <div className="gconnect-info">
          <strong>Spotify</strong>
          <span className="gconnect-status">
            {!st.configured
              ? "Add SPOTIFY_CLIENT_ID/SECRET in .env"
              : st.connected
                ? `Connected${st.account ? " · " + st.account : ""}`
                : "Not connected — needs Premium to play"}
          </span>
        </div>
      </div>
      {st.configured &&
        (st.connected ? (
          <button className="gconnect-btn ghost" onClick={disconnect}>Disconnect</button>
        ) : (
          <button className="gconnect-btn" onClick={connect}>Connect Spotify</button>
        ))}
    </div>
  );
}

export default function Dashboard({ session }) {
  const [data, setData] = useState(null); // null = first load in progress
  const [loadError, setLoadError] = useState("");
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState("all");
  const [isChatOpen, setIsChatOpen] = useState(false);
  // On mobile the sidebar is an overlay drawer that must start CLOSED, so a
  // desktop-persisted "collapsed" flag can't open it over 0-width content.
  const isMobile = useIsMobile();
  const [navCollapsed, setNavCollapsed] = useState(
    () => !window.matchMedia("(max-width: 900px)").matches && localStorage.getItem("ayus_nav_collapsed") === "1"
  );
  const [speakingAgent, setSpeakingAgent] = useState(null);
  const speakingRef = useRef(false); // so proactive alerts don't talk over a live reply

  const toggleNav = useCallback(() => {
    setNavCollapsed((c) => {
      const next = !c;
      // Only desktop collapse is a durable preference; the mobile drawer isn't.
      if (!window.matchMedia("(max-width: 900px)").matches) {
        localStorage.setItem("ayus_nav_collapsed", next ? "1" : "0");
      }
      return next;
    });
  }, []);
  const closeMobileNav = useCallback(() => {
    if (window.matchMedia("(max-width: 900px)").matches) setNavCollapsed(false);
  }, []);
  const [tab, setTab] = useState("ayus"); // ayus | agents | approvals | insights
  const [toast, setToast] = useState(null); // { msg, tone }
  const toastTimer = useRef(null);

  const showToast = useCallback((msg, tone = "ok") => {
    setToast({ msg, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(
    () =>
      onSpeaking((isSpeaking, agent) => {
        speakingRef.current = isSpeaking;
        setSpeakingAgent(isSpeaking ? agent : null);
      }),
    []
  );

  // Proactive alerts — near-real-time pings for things AYUS should flag the
  // moment they happen (overdue invoices, important unread mail). Poll, dedupe
  // by id across refreshes, toast each new one, and speak the top one (unless
  // AYUS is already talking or voice is muted).
  useEffect(() => {
    let alive = true;
    const SEEN_KEY = "ayus_seen_alerts";
    let seen = new Set();
    try {
      seen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
    } catch {
      /* corrupt store — start fresh */
    }

    async function poll() {
      try {
        const { alerts = [] } = await api("/proactive");
        if (!alive) return;
        const fresh = alerts.filter((a) => a?.id && !seen.has(a.id));
        if (!fresh.length) return;
        fresh.forEach((a) => seen.add(a.id));
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
        fresh.sort((a, b) => (b.severity === "high") - (a.severity === "high"));
        fresh.forEach((a) => showToast(`🔔 ${a.title}`, a.severity === "high" ? "err" : "warn"));
        if (localStorage.getItem("ayus_voice") !== "off" && !speakingRef.current) {
          speak(fresh[0].speak || fresh[0].message, "ayus");
        }
      } catch {
        /* offline / auth blip — retry next tick */
      }
    }

    poll();
    const t = setInterval(poll, 90000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [showToast]);

  // Surface the result of a Google / Spotify OAuth round-trip, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const g = params.get("google");
    const s = params.get("spotify");
    if (!g && !s) return;
    const gmap = {
      connected: ["Google connected ✓ — Gmail & Calendar are live", "ok"],
      error: ["Google connection failed — try again", "err"],
      badstate: ["Google connection expired — try again", "err"],
    };
    const smap = {
      connected: ["Spotify connected ✓ — AYUS can play songs now", "ok"],
      error: ["Spotify connection failed — try again", "err"],
      badstate: ["Spotify connection expired — try again", "err"],
    };
    const [msg, tone] = (g ? gmap[g] : smap[s]) || [];
    if (msg) setToast({ msg, tone });
    window.history.replaceState({}, "", window.location.pathname);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const load = useCallback(async () => {
    try {
      const overview = await api("/overview");
      setData(overview);
      setLoadError("");
    } catch (err) {
      setLoadError(String(err.message || err));
      setData((d) => d ?? { actions: [], digest: null, runs: [], stats: null });
    }
  }, []);

  // Poll faster while a run is in flight so agent cards flip back from
  // "working" the moment results land.
  const busy = running || data?.running;
  useEffect(() => {
    load();
    const interval = setInterval(load, busy ? 8000 : 60000);
    return () => clearInterval(interval);
  }, [load, busy]);

  async function decide(id, decision, reason = "") {
    try {
      const res = await api(`/actions/${id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, reason }),
      });
      const handoffNote = res?.handoffs?.length ? ` · ${res.handoffs.length} follow-up queued` : "";
      showToast(
        decision === "approved" ? `Approved — executed ✓${handoffNote}` : "Rejected — agent will learn from it",
        decision === "approved" ? "ok" : "warn"
      );
      setData((d) => ({ ...d, actions: d.actions.filter((a) => a.id !== id) }));
      load();
    } catch (err) {
      showToast("Failed: " + err.message, "err");
    }
  }

  async function runNow() {
    setRunning(true);
    showToast("Agents are running — this can take a minute…", "warn");
    try {
      await api("/run", { method: "POST" });
      showToast("Run complete ✓");
      load();
    } catch (err) {
      showToast("Run failed: " + err.message, "err");
    } finally {
      setRunning(false);
    }
  }

  const handleSelectAgent = (agentId) => {
    closeMobileNav();
    if (agentId === "secretary") {
      setIsChatOpen(true);
      setFilter("secretary");
    } else if (agentId === "ceo") {
      setFilter("all");
      setTab("agents");
    } else {
      const selecting = filter !== agentId;
      setFilter(selecting ? agentId : "all");
      // Navigate to approvals to show filtered cards
      if (selecting) setTab("approvals");
      // The agent reports in, out loud, when you select their seat
      if (selecting) {
        if (speakingAgent) stopSpeaking();
        const run = lastRunFor(agentId);
        const pending = countBy(agentId);
        const status = run?.status === "error"
          ? `kuch issue aaya last run mein: ${prettySummary(run.summary)}`
          : run
            ? `latest update: ${prettySummary(run.summary)}.`
            : "abhi tak koi run nahi hua.";
        const pendingLine = pending > 0 ? ` ${pending} proposal aapke approval ka wait kar raha hai.` : "";
        speak(`${AGENT_NAMES[agentId]} here. ${status}${pendingLine}`, voiceIdFor(agentId));
      } else {
        stopSpeaking();
      }
    }
  };

  const handleNavChange = (navId) => {
    setTab(navId);
    if (navId === "agents") setFilter("all");
    closeMobileNav(); // a tab pick dismisses the mobile drawer
  };

  const actions = data?.actions || [];
  const runs = data?.runs || [];
  const stats = data?.stats;
  const digest = data?.digest;
  const lastRun = runs[0];
  const visible = filter === "all" ? actions : actions.filter((a) => a.agent === filter);
  const countBy = (agent) => actions.filter((a) => a.agent === agent).length;
  const lastRunFor = (agent) => runs.find((r) => r.agent === agent);

  return (
    <>
      <div className="ambient" aria-hidden="true">
        <span /><span /><span /><span /><span />
        <i className="ambient-grid" />
      </div>
      <div className={`app-shell ${navCollapsed ? "nav-collapsed" : ""}`}>
        {isMobile && navCollapsed && (
          <div className="nav-backdrop" onClick={toggleNav} aria-hidden="true" />
        )}
        <Sidebar
          session={session}
          activeNav={tab}
          onNavChange={handleNavChange}
          agents={AGENTS}
          filter={filter}
          onSelectAgent={handleSelectAgent}
          busy={busy}
          lastRunFor={lastRunFor}
          countBy={countBy}
          speakingAgent={speakingAgent}
        />

        <TopBar busy={busy} running={running} runNow={runNow} navCollapsed={navCollapsed} onToggleNav={toggleNav} />

        <div className={`main-content ${tab === "vault" || tab === "docs" ? "main-content-full" : ""}`}>
          {/* AYUS — dedicated reactor page */}
          {tab === "ayus" && (
            <div className="ayus-page">
              <AyusReactor variant="page" onOpenChat={() => setIsChatOpen(true)} />
            </div>
          )}

          {/* Mission Control — the autonomous-org pipeline */}
          {tab === "missions" && (
            <MissionControl showToast={showToast} onProposed={load} />
          )}

          {/* Workflow Automation — trigger → steps over AYUS's primitives */}
          {tab === "workflows" && <Workflows showToast={showToast} />}

          {/* Agent Network — always visible on agents tab */}
          {tab === "agents" && (
            <>
              <AgentNetwork
                actions={actions}
                busy={busy}
                filter={filter}
                onSelectAgent={handleSelectAgent}
                lastRunFor={lastRunFor}
                countBy={countBy}
                speakingAgent={speakingAgent}
              />

              {stats && (
                <div className="stats-row">
                  <StatTile
                    label="Awaiting approval"
                    value={actions.length}
                    tone={actions.length ? "pending" : ""}
                    sub={actions.length ? "needs your decision" : "queue clear"}
                  />
                  <StatTile label="New leads" value={stats.newLeads} sub="not yet qualified" />
                  <StatTile
                    label="Unpaid invoices"
                    value={money(stats.unpaidTotal, stats.currency)}
                    sub={`${stats.unpaidCount} invoice${stats.unpaidCount === 1 ? "" : "s"} open`}
                  />
                  <StatTile
                    label="Last run"
                    value={lastRun ? timeAgo(lastRun.created_at) : "—"}
                    tone={lastRun?.status === "error" ? "err" : ""}
                    sub={lastRun ? (lastRun.status === "ok" ? "all good" : "had errors") : "never run"}
                  />
                </div>
              )}

              {digest && (
                <section className="wire">
                  <div className="lamp" />
                  <div style={{ flex: 1 }}>
                    <div className="wire-label">DAILY BRIEF</div>
                    <div className="wire-text">{digest.content}</div>
                    <div className="wire-date">{new Date(digest.created_at).toLocaleString()}</div>
                  </div>
                  <button
                    className="speak-brief-btn"
                    title={speakingAgent ? "Stop" : "Hear the brief from AYUS"}
                    onClick={() => (speakingAgent ? stopSpeaking() : speak(digest.content, "ayus"))}
                  >
                    {speakingAgent === "ayus" ? "■" : "🔊"}
                  </button>
                </section>
              )}
            </>
          )}

          {/* Approvals tab */}
          {tab === "approvals" && (
            <>
              <div className="flow-strip">
                <span>data lands in Supabase</span><b>→</b>
                <span>agents propose</span><b>→</b>
                <span>you approve</span><b>→</b>
                <span>it executes &amp; logs</span>
              </div>

              <div className="columns">
                <section className="col-main">
                  <div className="queue-head">
                    <h2>Awaiting your decision</h2>
                    <div className="chips">
                      <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
                        all {actions.length > 0 && <em>{actions.length}</em>}
                      </button>
                      {AGENTS.map((a) => (
                        <button key={a} className={`chip chip-${a} ${filter === a ? "on" : ""}`} onClick={() => setFilter(a)}>
                          {a} {countBy(a) > 0 && <em>{countBy(a)}</em>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {data === null ? (
                    <Skeleton />
                  ) : loadError ? (
                    <div className="empty">
                      Could not reach the server or database.
                      <div className="hint">{loadError}</div>
                    </div>
                  ) : visible.length === 0 ? (
                    <div className="empty">
                      <div className="empty-icon">✓</div>
                      {filter === "all" ? "Queue is clear. Nothing needs you right now." : `No pending ${filter} actions.`}
                      <div className="hint">Agents run daily, or hit "Run agents now".</div>
                    </div>
                  ) : (
                    visible.map((a) => <ActionCard key={a.id} action={a} onDecide={decide} />)
                  )}
                </section>

                <aside className="col-side">
                  <GoogleConnect showToast={showToast} />
                  <SpotifyConnect showToast={showToast} />
                  <h2 className="side-title">Recent agent runs</h2>
                  {data === null ? (
                    <div className="skeleton" style={{ height: 200 }} />
                  ) : runs.length === 0 ? (
                    <div className="run-row muted">No runs yet.</div>
                  ) : (
                    runs.map((r) => (
                      <div className="run-row" key={r.id} title={r.summary || ""}>
                        <span className={`run-dot ${r.status === "ok" ? "run-ok" : "run-error"}`} />
                        <div className="run-body">
                          <div className="run-line1">
                            <span className="agent">{r.agent}</span>
                            <span className="when">{timeAgo(r.created_at)}</span>
                          </div>
                          <div className={`run-summary ${r.status === "error" ? "is-error" : ""}`}>
                            {prettySummary(r.summary)}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </aside>
              </div>
            </>
          )}

          {/* Insights tab */}
          {tab === "insights" && <InsightsPanel active={true} />}

          {/* Lead Pipeline — inbox as a live list + AI scan → leads */}
          {tab === "leads" && <LeadPipeline showToast={showToast} onChanged={load} />}

          {/* Contacts — the name → number book AYUS sends WhatsApp from */}
          {tab === "contacts" && <Contacts showToast={showToast} />}

          {/* Notes — project working memory; AYUS and Arjun write into it */}
          {tab === "notes" && <Notes showToast={showToast} />}

          {/* Knowledge Vault — ANISH second brain 2D force graph + note inspector */}
          {tab === "vault" && <KnowledgeVault showToast={showToast} />}

          {/* Documentation — every repo doc mirrored into the vault, rendered */}
          {tab === "docs" && <Docs showToast={showToast} />}
        </div>
      </div>

      <button
        className={`floating-chat-trigger ${isChatOpen ? "hidden" : ""}`}
        onClick={() => setIsChatOpen(true)}
        title="Talk to AYUS (Secretary)"
      >
        <div className="trigger-pulse" />
        <span className="trigger-icon">💬</span>
      </button>

      <AyusChatDrawer
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        onActionProposed={load}
        showToast={showToast}
      />

      {toast && <div className={`toast show toast-${toast.tone}`}>{toast.msg}</div>}
    </>
  );
}
