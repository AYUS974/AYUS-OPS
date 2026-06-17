import { useState } from "react";
import { getSupabase } from "../lib/api.js";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: authError } = await getSupabase().auth.signInWithPassword({ email, password });
    if (authError) {
      setError(authError.message);
      setBusy(false);
    }
    // On success the onAuthStateChange listener in App swaps to the dashboard.
  }

  return (
    <div className="center-screen">
      <div className="login-backdrop-glow" style={{
        position: 'absolute',
        width: '300px',
        height: '300px',
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(168, 85, 247, 0.08) 0%, transparent 70%)',
        filter: 'blur(40px)',
        zIndex: 0,
        pointerEvents: 'none'
      }} />
      <form className="login-card" onSubmit={handleSubmit} style={{ position: 'relative', zIndex: 1 }}>
        <div className="wordmark" style={{ marginBottom: 24, justifyContent: 'center' }}>
          <h1 style={{ fontSize: 26 }}>AYUS&nbsp;OPS</h1>
          <span style={{ fontSize: 9 }}>portal</span>
        </div>
        
        <h2 style={{ 
          fontSize: '14px', 
          fontWeight: 600, 
          textAlign: 'center', 
          color: 'var(--muted-bright)',
          marginBottom: 16,
          letterSpacing: '0.02em',
          textTransform: 'uppercase'
        }}>
          Security Verification Required
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="login-label" htmlFor="email">Access Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            placeholder="founder@ayuslabs.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              background: 'rgba(5, 7, 16, 0.6)',
              border: '1px solid var(--line)',
              borderBottom: '2px solid var(--line)',
              borderRadius: '6px',
              padding: '12px 14px',
              fontFamily: 'var(--mono)',
              fontSize: '13px'
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
          <label className="login-label" htmlFor="password">Passkey</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              background: 'rgba(5, 7, 16, 0.6)',
              border: '1px solid var(--line)',
              borderBottom: '2px solid var(--line)',
              borderRadius: '6px',
              padding: '12px 14px',
              fontFamily: 'var(--mono)',
              fontSize: '13px'
            }}
          />
        </div>

        {error && (
          <div className="login-error" style={{
            fontSize: '12px',
            color: 'var(--reject)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            background: 'rgba(239, 68, 68, 0.05)',
            padding: '10px',
            borderRadius: '6px',
            marginTop: 18,
            fontFamily: 'var(--mono)'
          }}>
            ✕ {error}
          </div>
        )}

        <button className="btn login-btn" disabled={busy} style={{
          marginTop: 24,
          padding: '13px 20px',
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          fontSize: '12.5px',
          cursor: 'pointer'
        }}>
          {busy ? "Authorizing access…" : "Authorize Command"}
        </button>

        <div className="login-hint">
          AYUS Ops mission control verification node.
        </div>
      </form>
    </div>
  );
}
